// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `hidden-native` on macOS. The browser renders on a private virtual display
// (`CGVirtualDisplay`, see `browser_display_virtual.rs`); this module holds
// the macOS calls behind it, and the fallback used when that display cannot
// be created: the browser runs on the owner's desktop as a hidden
// application that never takes focus.
//
// `CGVirtualDisplay` is private CoreGraphics API, the one display utilities
// such as BetterDisplay and DeskPad use. Its classes are looked up at run
// time, so a macOS without them falls back instead of failing to load.
//
// Measured for the fallback on macOS 26 with Chrome 155 (divan entry
// "background connector browsers can stay out of the user's face",
// follow-up 4):
// - A browser started as a child process activates itself about 400 ms in,
//   even when hidden first, and unhides itself whenever it creates a
//   window. Hiding after the fact cannot avoid a flash or a focus change.
// - Launched through LaunchServices without activation and hidden, it stays
//   inactive, and with this module's watcher re-hiding it no window reaches
//   the screen.
// - A hidden browser still runs pages, timers and input, so collection
//   works, but its compositor produces no screencast frames. The companion
//   therefore needs `reveal`, which unhides the browser without activating
//   it.
//
// Both launch the browser through LaunchServices without activation.
// LaunchServices, not the host, is then the browser's parent. Its process is
// stopped by process group, guarded by its recorded start time so a reused
// process id is never signalled, and a small watchdog stops it if the host
// itself dies, so a crashed host does not leave a browser behind on the
// owner's screen.

use super::virtual_display::{
    corner_origin, PrivateDisplay, ScreenRect, StartedBrowser, VirtualDisplayPlatform,
};
use super::{
    BrowserDisplayLaunch, BrowserProcess, ConcealmentTracker, DisplaySession, ObservedVisibility,
    SpawnedBrowser,
};
use objc2::msg_send;
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_core_foundation::{CFDictionary, CGRect, CGSize};
use objc2_core_graphics::{
    kCGNullDirectDisplay, kCGNullWindowID, CGBeginDisplayConfiguration,
    CGCancelDisplayConfiguration, CGCompleteDisplayConfiguration,
    CGConfigureDisplayMirrorOfDisplay, CGConfigureDisplayOrigin, CGConfigureOption,
    CGDirectDisplayID, CGDisplayBounds, CGDisplayConfigRef, CGDisplayMirrorsDisplay, CGError,
    CGGetActiveDisplayList, CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString, NSURL};
use std::ffi::{c_void, CStr};
use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const WATCH_PERIOD: Duration = Duration::from_millis(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_WAIT: Duration = Duration::from_secs(5);
const REVEAL_WAIT: Duration = Duration::from_secs(2);

/// Waits for the window server to list, place or remove a private display.
const DISPLAY_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);
/// Identifies DataConnect's private displays to macOS, which remembers the
/// arrangement of each display it has seen by vendor, product and serial.
const DISPLAY_VENDOR_ID: u32 = 0xDA7A;
const DISPLAY_PRODUCT_ID: u32 = 0xC0DE;
const DISPLAY_NAME: &str = "DataConnect browser display";

/// The macOS calls behind the private-display backend.
pub(crate) struct MacDisplays;

impl VirtualDisplayPlatform for MacDisplays {
    fn create_display(
        &self,
        width: u32,
        height: u32,
        deadline: Instant,
    ) -> Result<Box<dyn PrivateDisplay>, String> {
        let display = autoreleasepool(|_| VirtualDisplay::create(width, height, deadline))?;
        Ok(Box::new(display))
    }

    fn launch_browser(&self, command: Command) -> io::Result<StartedBrowser> {
        let (browser, pid, started) = launch(command, false)?;
        Ok(StartedBrowser {
            browser,
            alive: Box::new(move || process_start_time(pid) == Some(started)),
        })
    }

    fn windows_on_owner_displays(&self, pid: u32, private: &ScreenRect) -> u32 {
        let owner: Vec<ScreenRect> = active_displays()
            .into_iter()
            .map(display_bounds)
            .filter(|bounds| bounds != private)
            .collect();
        browser_windows(pid as libc::pid_t)
            .iter()
            .filter(|window| owner.iter().any(|display| display.overlaps(window)))
            .count() as u32
    }

    fn fallback_session(&self) -> Box<dyn DisplaySession> {
        Box::new(HiddenNativeSession {
            launch: BrowserDisplayLaunch {
                args: vec!["--no-startup-window".into()],
                pages_open_in_background: true,
                ..BrowserDisplayLaunch::default()
            },
            watch: Arc::new(Watch::default()),
            watcher: None,
            pid: None,
        })
    }
}

/// Serial numbers of the private displays this process has now. Each
/// display needs its own while it exists; reusing the lowest free one keeps
/// the arrangements macOS remembers to a few entries.
static DISPLAY_SERIALS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn take_serial() -> u32 {
    let mut serials = DISPLAY_SERIALS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let serial = (1..).find(|serial| !serials.contains(serial)).unwrap_or(1);
    serials.push(serial);
    serial
}

fn release_serial(serial: u32) {
    let mut serials = DISPLAY_SERIALS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    serials.retain(|existing| *existing != serial);
}

extern "C" {
    fn dispatch_get_global_queue(identifier: isize, flags: usize) -> *mut c_void;
}

/// A `CGVirtualDisplay`. The display exists while this object does.
struct VirtualDisplay {
    display: Option<Retained<AnyObject>>,
    id: CGDirectDisplayID,
    serial: u32,
    bounds: ScreenRect,
}

// SAFETY: the CGVirtualDisplay is only retained here and released in Drop;
// nothing else is called on it after creation, and Objective-C reference
// counting is thread-safe.
unsafe impl Send for VirtualDisplay {}

impl VirtualDisplay {
    fn create(width: u32, height: u32, deadline: Instant) -> Result<Self, String> {
        let class = |name: &CStr| {
            AnyClass::get(name)
                .ok_or_else(|| format!("this macOS has no {} class", name.to_string_lossy()))
        };
        let descriptor_class = class(c"CGVirtualDisplayDescriptor")?;
        let settings_class = class(c"CGVirtualDisplaySettings")?;
        let mode_class = class(c"CGVirtualDisplayMode")?;
        let display_class = class(c"CGVirtualDisplay")?;
        let owner: Vec<ScreenRect> = active_displays().into_iter().map(display_bounds).collect();
        let serial = take_serial();
        // From here on, dropping `display` removes the display and frees the
        // serial number, so every error path below cleans up.
        let mut display = Self {
            display: None,
            id: kCGNullDirectDisplay,
            serial,
            bounds: ScreenRect {
                x: 0,
                y: 0,
                width,
                height,
            },
        };
        // SAFETY: the selectors and argument types are those of the
        // CGVirtualDisplay classes on macOS 11 and later (as used by
        // Chromium's virtual display test utility); debug builds verify
        // each signature against the runtime before sending.
        unsafe {
            let descriptor: Retained<AnyObject> = msg_send![descriptor_class, new];
            let queue = dispatch_get_global_queue(0, 0).cast::<AnyObject>();
            let _: () = msg_send![&*descriptor, setQueue: queue];
            let name = NSString::from_str(DISPLAY_NAME);
            let _: () = msg_send![&*descriptor, setName: &*name];
            let _: () = msg_send![&*descriptor, setMaxPixelsWide: width];
            let _: () = msg_send![&*descriptor, setMaxPixelsHigh: height];
            // The physical size of a 96 dpi screen of this resolution.
            let millimetres = |pixels: u32| f64::from(pixels) * 25.4 / 96.0;
            let size = CGSize::new(millimetres(width), millimetres(height));
            let _: () = msg_send![&*descriptor, setSizeInMillimeters: size];
            let _: () = msg_send![&*descriptor, setVendorID: DISPLAY_VENDOR_ID];
            let _: () = msg_send![&*descriptor, setProductID: DISPLAY_PRODUCT_ID];
            let _: () = msg_send![&*descriptor, setSerialNum: serial];

            let allocated: Allocated<AnyObject> = msg_send![display_class, alloc];
            let created: Option<Retained<AnyObject>> =
                msg_send![allocated, initWithDescriptor: &*descriptor];
            let created = created.ok_or("macOS refused to create a virtual display")?;
            display.id = msg_send![&*created, displayID];
            display.display = Some(created);

            let settings: Retained<AnyObject> = msg_send![settings_class, new];
            let _: () = msg_send![&*settings, setHiDPI: 0_u32];
            let allocated: Allocated<AnyObject> = msg_send![mode_class, alloc];
            let mode: Retained<AnyObject> = msg_send![
                allocated,
                initWithWidth: width,
                height: height,
                refreshRate: 60.0_f64
            ];
            let modes = NSArray::from_retained_slice(&[mode]);
            let _: () = msg_send![&*settings, setModes: &*modes];
            let target = display.display.as_deref().expect("just stored");
            let applied: bool = msg_send![target, applySettings: &*settings];
            if !applied {
                return Err("macOS refused the virtual display's mode".into());
            }
        }
        if display.id == kCGNullDirectDisplay {
            return Err("the virtual display has no display id".into());
        }
        let deadline = deadline.min(Instant::now() + DISPLAY_SETTLE_TIMEOUT);
        wait_until(deadline, || active_displays().contains(&display.id))
            .map_err(|()| "the virtual display did not come online".to_string())?;
        let (x, y) = corner_origin(&owner, height);
        configure_display(display.id, x, y)?;
        let wanted = ScreenRect {
            x,
            y,
            width,
            height,
        };
        // The window server applies the arrangement asynchronously.
        let _ = wait_until(deadline, || display_bounds(display.id) == wanted);
        display.bounds = display_bounds(display.id);
        if CGDisplayMirrorsDisplay(display.id) != kCGNullDirectDisplay {
            return Err("macOS mirrors the virtual display onto a physical display".into());
        }
        if let Some(touching) = owner.iter().find(|screen| {
            screen.shares_edge_with(&display.bounds) || screen.overlaps(&display.bounds)
        }) {
            log::warn!(
                "macOS placed the private browser display at {:?} next to {:?}, not at {x},{y}; the pointer can move onto it",
                display.bounds,
                touching
            );
        }
        Ok(display)
    }
}

impl PrivateDisplay for VirtualDisplay {
    fn bounds(&self) -> ScreenRect {
        self.bounds
    }
}

impl Drop for VirtualDisplay {
    fn drop(&mut self) {
        if let Some(display) = self.display.take() {
            autoreleasepool(|_| drop(display));
            let id = self.id;
            let removed = wait_until(Instant::now() + DISPLAY_SETTLE_TIMEOUT, || {
                !active_displays().contains(&id)
            });
            match removed {
                Ok(()) => log::info!("Removed private browser display {id}"),
                Err(()) => log::warn!("Private browser display {id} is still listed after removal"),
            }
        }
        release_serial(self.serial);
    }
}

/// Mirroring off and the origin at `x`, `y`, for this process only: macOS
/// reverts the arrangement when the process exits.
fn configure_display(id: CGDirectDisplayID, x: i32, y: i32) -> Result<(), String> {
    let mut config: CGDisplayConfigRef = std::ptr::null_mut();
    // SAFETY: `config` is created by Begin and consumed by Complete or
    // Cancel on every path.
    unsafe {
        if CGBeginDisplayConfiguration(&mut config) != CGError::Success {
            return Err("macOS refused to configure displays".into());
        }
        let mirror = CGConfigureDisplayMirrorOfDisplay(config, id, kCGNullDirectDisplay);
        let origin = CGConfigureDisplayOrigin(config, id, x, y);
        if mirror != CGError::Success || origin != CGError::Success {
            CGCancelDisplayConfiguration(config);
            return Err(format!(
                "macOS refused to place the virtual display (mirror {}, origin {})",
                mirror.0, origin.0
            ));
        }
        let complete = CGCompleteDisplayConfiguration(config, CGConfigureOption::ForAppOnly);
        if complete != CGError::Success {
            return Err(format!(
                "macOS refused to place the virtual display ({})",
                complete.0
            ));
        }
    }
    Ok(())
}

fn wait_until(deadline: Instant, mut done: impl FnMut() -> bool) -> Result<(), ()> {
    loop {
        if done() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn active_displays() -> Vec<CGDirectDisplayID> {
    let mut ids = [0 as CGDirectDisplayID; 32];
    let mut count = 0_u32;
    // SAFETY: CoreGraphics writes at most `ids.len()` ids and the count.
    let result = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if result != CGError::Success {
        return Vec::new();
    }
    ids[..count as usize].to_vec()
}

fn display_bounds(id: CGDirectDisplayID) -> ScreenRect {
    let bounds = CGDisplayBounds(id);
    ScreenRect {
        x: bounds.origin.x.round() as i32,
        y: bounds.origin.y.round() as i32,
        width: bounds.size.width.round() as u32,
        height: bounds.size.height.round() as u32,
    }
}

#[derive(Default)]
struct Watch {
    tracker: Mutex<ConcealmentTracker>,
    stop: AtomicBool,
}

struct HiddenNativeSession {
    launch: BrowserDisplayLaunch,
    watch: Arc<Watch>,
    watcher: Option<JoinHandle<()>>,
    pid: Option<libc::pid_t>,
}

impl DisplaySession for HiddenNativeSession {
    fn browser_launch(&self) -> &BrowserDisplayLaunch {
        &self.launch
    }

    fn spawn(&mut self, command: Command) -> io::Result<SpawnedBrowser> {
        let (browser, pid, _) = launch(command, true)?;
        self.pid = Some(pid);
        let watch = Arc::clone(&self.watch);
        self.watcher = Some(
            thread::Builder::new()
                .name("browser-conceal".into())
                .spawn(move || watch_and_conceal(pid, &watch))?,
        );
        Ok(browser)
    }

    fn observed_visibility(&self) -> ObservedVisibility {
        self.watch
            .tracker
            .lock()
            .map_or(ObservedVisibility::Unknown, |tracker| tracker.visibility())
    }

    fn streams_while_concealed(&self) -> bool {
        false
    }

    fn reveal(&mut self) -> Result<(), String> {
        let pid = self.pid.ok_or("The browser has not started")?;
        {
            let mut tracker = self
                .watch
                .tracker
                .lock()
                .map_err(|_| "The concealment state is unavailable")?;
            tracker.reveal();
            // unhide shows the browser without activating it. It reports
            // false even when it works, and a single NSRunningApplication's
            // state goes stale off the main run loop, so success is
            // confirmed on fresh lookups below.
            running_application(pid)
                .ok_or("The browser is no longer running")?
                .unhide();
        }
        let deadline = Instant::now() + REVEAL_WAIT;
        while Instant::now() < deadline {
            if running_application(pid).is_some_and(|app| !app.isHidden()) {
                return Ok(());
            }
            thread::sleep(WATCH_PERIOD);
        }
        Err("macOS did not show the browser".into())
    }

    fn terminate(&mut self) -> bool {
        self.watch.stop.store(true, Ordering::Release);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        true
    }
}

impl Drop for HiddenNativeSession {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// The `.app` bundle that contains `executable`. LaunchServices launches
/// bundles, not executables.
fn app_bundle(executable: &Path) -> io::Result<PathBuf> {
    executable
        .ancestors()
        .find(|ancestor| {
            ancestor
                .extension()
                .is_some_and(|extension| extension == "app")
        })
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "{} is not inside an application bundle, so it cannot be launched without taking focus",
                    executable.display()
                ),
            )
        })
}

/// Launch the browser `command` names through LaunchServices without
/// activating it, hidden when `hidden`. Returns the browser, its process id
/// and its start time.
fn launch(command: Command, hidden: bool) -> io::Result<(SpawnedBrowser, libc::pid_t, u64)> {
    let bundle = app_bundle(Path::new(command.get_program()))?;
    let arguments: Vec<String> = command
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let pid = launch_app(&bundle, &arguments, hidden)?;
    let started = process_start_time(pid)
        .ok_or_else(|| io::Error::other("The browser exited before it could be identified"))?;
    let profile = arguments
        .iter()
        .find(|argument| argument.starts_with("--user-data-dir="));
    let watchdog = profile.and_then(|profile| match spawn_watchdog(pid, profile) {
        Ok(watchdog) => Some(watchdog),
        Err(error) => {
            log::warn!("The browser will outlive a crash of this app: {error}");
            None
        }
    });
    Ok((
        SpawnedBrowser {
            process: Box::new(LaunchedBrowser {
                pid,
                started,
                watchdog,
            }),
            stdout: None,
            stderr: None,
        },
        pid,
        started,
    ))
}

/// Stops the browser's process group when the host exits without stopping
/// it: the script waits for end of input on a pipe only the host holds. It
/// signals only a process that still has this browser's profile argument,
/// so a reused process id is never signalled.
const WATCHDOG_SCRIPT: &str = r#"read -r _
mine() { ps -ww -o command= -p "$1" 2>/dev/null | grep -qF -- "$2"; }
if mine "$1" "$2"; then
  kill -TERM -- "-$1" 2>/dev/null
  i=0
  while [ "$i" -lt 50 ] && mine "$1" "$2"; do sleep 0.1; i=$((i + 1)); done
  if mine "$1" "$2"; then kill -KILL -- "-$1" 2>/dev/null; fi
fi"#;

fn spawn_watchdog(pid: libc::pid_t, profile_argument: &str) -> io::Result<Child> {
    Command::new("/bin/sh")
        .arg("-c")
        .arg(WATCHDOG_SCRIPT)
        .arg("dataconnect-browser-watchdog")
        .arg(pid.to_string())
        .arg(profile_argument)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Not in the host's group, so a signal to that group leaves the
        // watchdog to clean up.
        .process_group(0)
        .spawn()
}

/// Launch a new instance of `bundle` without activating it.
fn launch_app(bundle: &Path, arguments: &[String], hidden: bool) -> io::Result<libc::pid_t> {
    let (sender, receiver) = mpsc::channel::<Result<libc::pid_t, String>>();
    let sender = Mutex::new(Some(sender));
    let completion =
        block2::RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
            // SAFETY: LaunchServices passes a valid application or a valid
            // error (or null) for the duration of this call.
            let (app, error) = unsafe { (app.as_ref(), error.as_ref()) };
            let result = match app {
                Some(app) => Ok(app.processIdentifier()),
                None => {
                    Err(error.map_or_else(|| "unknown error".into(), |error| error.to_string()))
                }
            };
            if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                let _ = sender.send(result);
            }
        });
    let path = NSString::from_str(&bundle.to_string_lossy());
    let arguments: Vec<Retained<NSString>> = arguments
        .iter()
        .map(|argument| NSString::from_str(argument))
        .collect();
    let url = NSURL::fileURLWithPath(&path);
    let configuration = NSWorkspaceOpenConfiguration::configuration();
    configuration.setActivates(false);
    configuration.setHides(hidden);
    // A separate instance even when the owner's own Chrome is running.
    configuration.setCreatesNewApplicationInstance(true);
    configuration.setAddsToRecentItems(false);
    configuration.setArguments(&NSArray::from_retained_slice(&arguments));
    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
        &url,
        &configuration,
        Some(&completion),
    );
    match receiver.recv_timeout(LAUNCH_TIMEOUT) {
        Ok(Ok(pid)) if pid > 0 => Ok(pid),
        Ok(Ok(_)) => Err(io::Error::other("LaunchServices returned no process")),
        Ok(Err(error)) => Err(io::Error::other(format!("LaunchServices: {error}"))),
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "LaunchServices did not report the launch",
        )),
    }
}

fn running_application(pid: libc::pid_t) -> Option<Retained<NSRunningApplication>> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
}

/// Keep the browser hidden until it is revealed or stopped. The browser
/// activates and unhides itself whenever it opens a foreground page, which
/// connectors do on every run, so this checks the window server on every
/// observation: the application's own hidden state lags when no main run
/// loop updates it.
fn watch_and_conceal(pid: libc::pid_t, watch: &Watch) {
    while !watch.stop.load(Ordering::Acquire) {
        let Ok(mut tracker) = watch.tracker.lock() else {
            return;
        };
        if tracker.is_revealed() {
            return;
        }
        let conceal = tracker.observe(on_screen_windows(pid));
        // A fresh lookup each time: one instance's state goes stale off the
        // main run loop.
        let Some(app) = running_application(pid) else {
            return;
        };
        // Still holding the tracker: `reveal` takes it too, so a reveal can
        // never be undone by a hide decided just before it.
        if conceal || !app.isHidden() {
            app.hide();
        }
        drop(tracker);
        thread::sleep(WATCH_PERIOD);
    }
}

/// Ordinary (layer 0) windows of `pid` that are on screen now.
fn on_screen_windows(pid: libc::pid_t) -> u32 {
    browser_windows(pid).len() as u32
}

/// The bounds of `pid`'s ordinary (layer 0) windows that are on screen now,
/// on any display.
fn browser_windows(pid: libc::pid_t) -> Vec<ScreenRect> {
    let Some(windows) =
        CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, kCGNullWindowID)
    else {
        return Vec::new();
    };
    // SAFETY: CFArray is toll-free bridged to NSArray, and the window list
    // holds dictionaries.
    let windows: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*(&*windows as *const objc2_core_foundation::CFArray).cast() };
    let owner = NSString::from_str("kCGWindowOwnerPID");
    let layer = NSString::from_str("kCGWindowLayer");
    let bounds_key = NSString::from_str("kCGWindowBounds");
    let number = |window: &NSDictionary<NSString, AnyObject>, key: &NSString| {
        window
            .objectForKey(key)?
            .downcast::<NSNumber>()
            .ok()
            .map(|value| value.longLongValue())
    };
    windows
        .iter()
        .filter(|window| {
            number(window, &owner) == Some(i64::from(pid)) && number(window, &layer) == Some(0)
        })
        .map(|window| {
            let mut rect = CGRect::default();
            if let Some(bounds) = window.objectForKey(&bounds_key) {
                // SAFETY: the window server stores the bounds as a
                // CFDictionary, toll-free bridged to the object returned.
                let bounds: &CFDictionary =
                    unsafe { &*(&*bounds as *const AnyObject).cast::<CFDictionary>() };
                // SAFETY: writes one CGRect into `rect`.
                unsafe {
                    CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect);
                }
            }
            ScreenRect {
                x: rect.origin.x.round() as i32,
                y: rect.origin.y.round() as i32,
                width: rect.size.width.max(0.0).round() as u32,
                height: rect.size.height.max(0.0).round() as u32,
            }
        })
        .collect()
}

/// A browser launched by LaunchServices. It leads its own process group.
struct LaunchedBrowser {
    pid: libc::pid_t,
    /// Start time in microseconds, to tell this process from a later one
    /// that reuses its id.
    started: u64,
    /// Stops the browser if the host dies first. Stopped with the browser.
    watchdog: Option<Child>,
}

impl LaunchedBrowser {
    fn is_same_process(&self) -> bool {
        process_start_time(self.pid) == Some(self.started)
    }

    fn group_exists(&self) -> bool {
        // SAFETY: signal 0 only checks for the existence of the group.
        let result = unsafe { libc::kill(-self.pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn wait_for_group_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.group_exists() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        true
    }
}

impl BrowserProcess for LaunchedBrowser {
    fn id(&self) -> u32 {
        self.pid as u32
    }

    fn has_exited(&mut self) -> bool {
        !self.is_same_process()
    }

    fn terminate(&mut self) -> bool {
        for signal in [libc::SIGTERM, libc::SIGKILL] {
            // The leader's identity is checked before each signal. Once the
            // leader is gone its helpers may outlive it briefly; the group
            // id cannot be reused while any of them lives.
            if self.is_same_process() {
                // SAFETY: signals the group this browser leads.
                unsafe { libc::kill(-self.pid, signal) };
            } else if self.group_exists() {
                // SAFETY: as above. The group still has members, so its id
                // is still this browser's.
                unsafe { libc::kill(-self.pid, signal) };
            }
            if self.wait_for_group_exit(STOP_WAIT) {
                if let Some(mut watchdog) = self.watchdog.take() {
                    let _ = watchdog.kill();
                    let _ = watchdog.wait();
                }
                return true;
            }
        }
        false
    }
}

/// The process's start time in microseconds, or None when it does not exist.
fn process_start_time(pid: libc::pid_t) -> Option<u64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (written == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_is_found_from_the_executable_inside_it() {
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ))
            .expect("bundle"),
            PathBuf::from("/Applications/Google Chrome.app")
        );
        let error = app_bundle(Path::new("/usr/local/bin/chromium")).expect_err("no bundle");
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    }

    #[test]
    fn a_missing_process_has_no_start_time() {
        assert!(process_start_time(std::process::id() as libc::pid_t).is_some());
        assert!(process_start_time(i32::MAX).is_none());
    }
}
