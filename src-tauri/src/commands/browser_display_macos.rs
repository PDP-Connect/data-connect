// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `hidden-native` on macOS: the browser runs on the owner's desktop as a
// hidden application that never takes focus.
//
// Measured on macOS 26 with Chrome 155 (divan entry "background connector
// browsers can stay out of the user's face", follow-up 4):
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
// LaunchServices, not the host, is the browser's parent. Its process is
// stopped by process group, guarded by its recorded start time so a reused
// process id is never signalled.

use super::{
    BrowserDisplayLaunch, BrowserProcess, ConcealmentTracker, DisplayBackend, DisplayProvider,
    DisplaySession, ObservedVisibility, SpawnedBrowser,
};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_core_graphics::{kCGNullWindowID, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString, NSURL};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const WATCH_PERIOD: Duration = Duration::from_millis(5);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_WAIT: Duration = Duration::from_secs(5);
const REVEAL_WAIT: Duration = Duration::from_secs(2);

pub(crate) struct HiddenNativeProvider;

impl DisplayProvider for HiddenNativeProvider {
    fn backend(&self) -> DisplayBackend {
        DisplayBackend::HiddenNative
    }

    fn start(&self, _deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
        Ok(Box::new(HiddenNativeSession {
            launch: BrowserDisplayLaunch {
                args: vec!["--no-startup-window".into()],
                pages_open_in_background: true,
                ..BrowserDisplayLaunch::default()
            },
            watch: Arc::new(Watch::default()),
            watcher: None,
            pid: None,
        }))
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
        let bundle = app_bundle(Path::new(command.get_program()))?;
        let arguments: Vec<String> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        let pid = launch_hidden(&bundle, &arguments)?;
        let started = process_start_time(pid)
            .ok_or_else(|| io::Error::other("The browser exited before it could be identified"))?;
        self.pid = Some(pid);
        let watch = Arc::clone(&self.watch);
        self.watcher = Some(
            thread::Builder::new()
                .name("browser-conceal".into())
                .spawn(move || watch_and_conceal(pid, &watch))?,
        );
        Ok(SpawnedBrowser {
            process: Box::new(LaunchedBrowser { pid, started }),
            stdout: None,
            stderr: None,
        })
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
        if let Ok(mut tracker) = self.watch.tracker.lock() {
            tracker.reveal();
        }
        // unhide shows the browser without activating it. It reports
        // false even when it works, and a single NSRunningApplication's
        // state goes stale off the main run loop, so success is confirmed
        // on fresh lookups.
        running_application(pid)
            .ok_or("The browser is no longer running")?
            .unhide();
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
                    "{} is not inside an application bundle, so it cannot be launched hidden",
                    executable.display()
                ),
            )
        })
}

/// Launch a new instance of `bundle`, hidden and without activating it.
fn launch_hidden(bundle: &Path, arguments: &[String]) -> io::Result<libc::pid_t> {
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
    configuration.setHides(true);
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
        drop(tracker);
        // A fresh lookup each time: one instance's state goes stale off the
        // main run loop.
        let Some(app) = running_application(pid) else {
            return;
        };
        if conceal || !app.isHidden() {
            app.hide();
        }
        thread::sleep(WATCH_PERIOD);
    }
}

/// Ordinary (layer 0) windows of `pid` that are on screen now.
fn on_screen_windows(pid: libc::pid_t) -> u32 {
    let Some(windows) =
        CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly, kCGNullWindowID)
    else {
        return 0;
    };
    // SAFETY: CFArray is toll-free bridged to NSArray, and the window list
    // holds dictionaries.
    let windows: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*(&*windows as *const objc2_core_foundation::CFArray).cast() };
    let owner = NSString::from_str("kCGWindowOwnerPID");
    let layer = NSString::from_str("kCGWindowLayer");
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
        .count() as u32
}

/// A browser launched by LaunchServices. It leads its own process group.
struct LaunchedBrowser {
    pid: libc::pid_t,
    /// Start time in microseconds, to tell this process from a later one
    /// that reuses its id.
    started: u64,
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
