// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `hidden-native` through a private virtual display: the host creates a
// display that no physical screen shows, starts the browser with its window
// on that display, and removes the display after the browser has stopped.
// This is the macOS counterpart of the private Xvfb display on Linux.
//
// Measured on macOS 26 with Chrome 155 (divan entry "background connector
// browsers can stay out of the user's face", follow-ups 5 and 6): a browser
// hidden by the operating system renders no screencast frames, so the
// companion had to reveal it on the owner's screen. On a virtual display the
// browser renders normally (60 frames per second, the display's refresh
// rate), no window reaches a physical display and the browser does not take
// focus.
//
// The display touches the owner's displays at one corner only. The cursor
// moves between displays only across a shared edge, so it cannot enter the
// private display.
//
// When the display cannot be created, the platform's fallback session is
// used instead (on macOS, the hidden application), and the log says so.
//
// The lifecycle here is platform-neutral so that it is tested on every CI
// runner; the operating system calls sit behind `VirtualDisplayPlatform`.
// Only macOS uses it outside tests.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use super::{
    BrowserDisplayLaunch, DisplayBackend, DisplayProvider, DisplaySession, ObservedVisibility,
    SpawnedBrowser,
};
use std::io;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// The private display's size in points. The same as the Linux private
/// display, so the companion sees the same page layout on both.
pub(crate) const DISPLAY_WIDTH: u32 = 1440;
pub(crate) const DISPLAY_HEIGHT: u32 = 900;
/// How often the session checks that the browser is alive and that none of
/// its windows reached the owner's displays.
const WATCH_PERIOD: Duration = Duration::from_millis(100);

/// A rectangle in global display coordinates (points, origin at the top
/// left of the main display, y grows downwards).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl ScreenRect {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// Whether the two rectangles have an area in common.
    pub(crate) fn overlaps(&self, other: &ScreenRect) -> bool {
        i64::from(self.x) < other.right()
            && i64::from(other.x) < self.right()
            && i64::from(self.y) < other.bottom()
            && i64::from(other.y) < self.bottom()
    }

    /// Whether the two rectangles touch along a segment longer than a point.
    /// The cursor can cross between two displays only there.
    pub(crate) fn shares_edge_with(&self, other: &ScreenRect) -> bool {
        let span = |a0: i64, a1: i64, b0: i64, b1: i64| a1.min(b1) - a0.max(b0);
        let vertical_contact = (self.right() == i64::from(other.x)
            || other.right() == i64::from(self.x))
            && span(
                i64::from(self.y),
                self.bottom(),
                i64::from(other.y),
                other.bottom(),
            ) > 0;
        let horizontal_contact = (self.bottom() == i64::from(other.y)
            || other.bottom() == i64::from(self.y))
            && span(
                i64::from(self.x),
                self.right(),
                i64::from(other.x),
                other.right(),
            ) > 0;
        vertical_contact || horizontal_contact
    }
}

/// Where to put a `width` x `height` private display so that it touches the
/// owner's displays only at a corner: above the top right corner of the
/// display that reaches furthest right (the highest of those when several
/// do). Nothing is to its right or above it, so it shares no edge with any
/// display.
pub(crate) fn corner_origin(owner_displays: &[ScreenRect], height: u32) -> (i32, i32) {
    let anchor = owner_displays
        .iter()
        .max_by_key(|display| (display.right(), -i64::from(display.y)));
    match anchor {
        Some(display) => (
            display.right() as i32,
            (i64::from(display.y) - i64::from(height)) as i32,
        ),
        None => (0, -(height as i32)),
    }
}

/// A created private display. It is removed when dropped.
pub(crate) trait PrivateDisplay: Send {
    fn bounds(&self) -> ScreenRect;
}

/// A browser the platform started, and how to tell that it is still alive.
pub(crate) struct StartedBrowser {
    pub browser: SpawnedBrowser,
    /// False once the browser has exited. Guarded against process id reuse.
    pub alive: Box<dyn Fn() -> bool + Send>,
}

/// The operating system calls behind this backend: real on macOS, fakes in
/// tests.
pub(crate) trait VirtualDisplayPlatform: Send + Sync + 'static {
    /// Create a display that no physical screen shows, placed so that it
    /// touches the owner's displays at most at a corner, and wait until the
    /// window server lists it. Leaves nothing behind when it fails.
    fn create_display(
        &self,
        width: u32,
        height: u32,
        deadline: Instant,
    ) -> Result<Box<dyn PrivateDisplay>, String>;

    /// Start the browser without activating it.
    fn launch_browser(&self, command: Command) -> io::Result<StartedBrowser>;

    /// How many of the browser's ordinary windows are on the owner's
    /// displays, that is, anywhere except `private`.
    fn windows_on_owner_displays(&self, pid: u32, private: &ScreenRect) -> u32;

    /// The session to use when no private display can be created.
    fn fallback_session(&self) -> Box<dyn DisplaySession>;
}

pub(crate) struct VirtualDisplayProvider<P> {
    platform: Arc<P>,
}

impl<P: VirtualDisplayPlatform> VirtualDisplayProvider<P> {
    pub(crate) fn new(platform: Arc<P>) -> Self {
        Self { platform }
    }
}

impl<P: VirtualDisplayPlatform> DisplayProvider for VirtualDisplayProvider<P> {
    fn backend(&self) -> DisplayBackend {
        DisplayBackend::HiddenNative
    }

    fn start(&self, deadline: Instant) -> Result<Box<dyn DisplaySession>, String> {
        match self
            .platform
            .create_display(DISPLAY_WIDTH, DISPLAY_HEIGHT, deadline)
        {
            Ok(display) => {
                let bounds = display.bounds();
                log::info!(
                    "Created a private display for the connector browser at {},{} ({}x{})",
                    bounds.x,
                    bounds.y,
                    bounds.width,
                    bounds.height
                );
                Ok(Box::new(VirtualDisplaySession::new(
                    Arc::clone(&self.platform),
                    display,
                )))
            }
            Err(error) => {
                log::warn!(
                    "Could not create a private display for the connector browser ({error}); \
                     hiding the browser instead. It renders no companion frames while hidden, \
                     so the companion will show it on the desktop when it opens."
                );
                Ok(self.platform.fallback_session())
            }
        }
    }
}

struct Shared {
    display: Mutex<Option<Box<dyn PrivateDisplay>>>,
    /// The most browser windows seen on the owner's displays at once.
    windows_seen_outside: AtomicU32,
    stop: AtomicBool,
}

impl Shared {
    /// Remove the display. Idempotent.
    fn remove_display(&self) {
        let display = match self.display.lock() {
            Ok(mut display) => display.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        drop(display);
    }
}

pub(crate) struct VirtualDisplaySession<P> {
    platform: Arc<P>,
    bounds: ScreenRect,
    launch: BrowserDisplayLaunch,
    shared: Arc<Shared>,
    watcher: Option<JoinHandle<()>>,
}

impl<P: VirtualDisplayPlatform> VirtualDisplaySession<P> {
    fn new(platform: Arc<P>, display: Box<dyn PrivateDisplay>) -> Self {
        let bounds = display.bounds();
        Self {
            platform,
            bounds,
            launch: BrowserDisplayLaunch {
                args: vec![
                    // No window until the first page is opened in the
                    // background over DevTools, so the browser never
                    // activates itself.
                    "--no-startup-window".into(),
                    format!("--window-position={},{}", bounds.x, bounds.y),
                    format!("--window-size={},{}", bounds.width, bounds.height),
                ],
                pages_open_in_background: true,
                ..BrowserDisplayLaunch::default()
            },
            shared: Arc::new(Shared {
                display: Mutex::new(Some(display)),
                windows_seen_outside: AtomicU32::new(0),
                stop: AtomicBool::new(false),
            }),
            watcher: None,
        }
    }
}

impl<P: VirtualDisplayPlatform> DisplaySession for VirtualDisplaySession<P> {
    fn browser_launch(&self) -> &BrowserDisplayLaunch {
        &self.launch
    }

    fn spawn(&mut self, command: Command) -> io::Result<SpawnedBrowser> {
        let StartedBrowser { browser, alive } = self.platform.launch_browser(command)?;
        let pid = browser.process.id();
        let platform = Arc::clone(&self.platform);
        let shared = Arc::clone(&self.shared);
        let bounds = self.bounds;
        self.watcher = Some(
            thread::Builder::new()
                .name("browser-display".into())
                .spawn(move || watch(pid, &*platform, &shared, &bounds, &*alive))?,
        );
        Ok(browser)
    }

    fn observed_visibility(&self) -> ObservedVisibility {
        if self.shared.windows_seen_outside.load(Ordering::Acquire) > 0 {
            ObservedVisibility::Visible
        } else {
            ObservedVisibility::IsolatedDisplay
        }
    }

    fn terminate(&mut self) -> bool {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        self.shared.remove_display();
        true
    }
}

impl<P> Drop for VirtualDisplaySession<P> {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        self.shared.remove_display();
    }
}

/// Until stopped: remove the display as soon as the browser exits (a crash
/// included), and record any browser window that reaches the owner's
/// displays. The browser always stops before its display, because the
/// display is removed only once the browser is gone.
fn watch<P: VirtualDisplayPlatform>(
    pid: u32,
    platform: &P,
    shared: &Shared,
    bounds: &ScreenRect,
    alive: &dyn Fn() -> bool,
) {
    while !shared.stop.load(Ordering::Acquire) {
        if !alive() {
            log::info!("Browser {pid} exited; removing its private display");
            shared.remove_display();
            return;
        }
        let outside = platform.windows_on_owner_displays(pid, bounds);
        if outside > 0 {
            let before = shared
                .windows_seen_outside
                .fetch_max(outside, Ordering::AcqRel);
            if before == 0 {
                log::warn!(
                    "Browser {pid} put {outside} window(s) on the owner's display instead of its private display"
                );
            }
        }
        thread::sleep(WATCH_PERIOD);
    }
}

#[cfg(test)]
mod tests {
    use super::super::BrowserProcess;
    use super::*;
    use crate::commands::browser_display::DisplayProviders;
    use crate::commands::owned_browser::tests::{Events, FakeDisplay};
    use crate::commands::owned_browser::{
        BrowserLauncher, LaunchSpec, BROWSER_DISPLAY_UNAVAILABLE, SURFACE_START_FAILED,
    };

    const MAIN: ScreenRect = ScreenRect {
        x: 0,
        y: 0,
        width: 1728,
        height: 1117,
    };

    #[test]
    fn the_private_display_touches_the_owner_displays_only_at_a_corner() {
        let layouts: [&[ScreenRect]; 4] = [
            &[MAIN],
            // An external display to the left and above the laptop.
            &[
                MAIN,
                ScreenRect {
                    x: -2560,
                    y: -1440,
                    width: 2560,
                    height: 1440,
                },
            ],
            // Two displays reaching equally far right: the higher one anchors.
            &[
                MAIN,
                ScreenRect {
                    x: 0,
                    y: -1080,
                    width: 1728,
                    height: 1080,
                },
            ],
            &[],
        ];
        for owner in layouts {
            let (x, y) = corner_origin(owner, DISPLAY_HEIGHT);
            let private = ScreenRect {
                x,
                y,
                width: DISPLAY_WIDTH,
                height: DISPLAY_HEIGHT,
            };
            for display in owner {
                assert!(
                    !private.overlaps(display),
                    "{private:?} overlaps {display:?}"
                );
                assert!(
                    !private.shares_edge_with(display),
                    "{private:?} shares an edge with {display:?}"
                );
            }
        }
        assert_eq!(corner_origin(&[MAIN], 900), (1728, -900));
    }

    #[test]
    fn edges_and_corners_are_told_apart() {
        let right = ScreenRect {
            x: 1728,
            y: 100,
            width: 100,
            height: 100,
        };
        assert!(MAIN.shares_edge_with(&right));
        let corner = ScreenRect {
            x: 1728,
            y: -100,
            width: 100,
            height: 100,
        };
        assert!(!MAIN.shares_edge_with(&corner));
        assert!(!MAIN.overlaps(&corner));
        let below = ScreenRect {
            x: 10,
            y: 1117,
            width: 100,
            height: 100,
        };
        assert!(MAIN.shares_edge_with(&below));
    }

    struct FakePrivateDisplay {
        events: Events,
    }

    impl PrivateDisplay for FakePrivateDisplay {
        fn bounds(&self) -> ScreenRect {
            ScreenRect {
                x: 1728,
                y: -900,
                width: DISPLAY_WIDTH,
                height: DISPLAY_HEIGHT,
            }
        }
    }

    impl Drop for FakePrivateDisplay {
        fn drop(&mut self) {
            self.events.push("display-removed");
        }
    }

    struct FakeProcess {
        alive: Arc<AtomicBool>,
        events: Events,
    }

    impl BrowserProcess for FakeProcess {
        fn id(&self) -> u32 {
            4343
        }

        fn has_exited(&mut self) -> bool {
            !self.alive.load(Ordering::Acquire)
        }

        fn terminate(&mut self) -> bool {
            if self.alive.swap(false, Ordering::AcqRel) {
                self.events.push("browser-stop");
            }
            true
        }
    }

    #[derive(Default)]
    struct FakePlatform {
        events: Events,
        create_fails: bool,
        launch_fails: bool,
        windows_outside: AtomicU32,
        alive: Arc<AtomicBool>,
        commands: Mutex<Vec<Vec<String>>>,
    }

    impl VirtualDisplayPlatform for FakePlatform {
        fn create_display(
            &self,
            width: u32,
            height: u32,
            _deadline: Instant,
        ) -> Result<Box<dyn PrivateDisplay>, String> {
            assert_eq!((width, height), (DISPLAY_WIDTH, DISPLAY_HEIGHT));
            if self.create_fails {
                self.events.push("display-create-failed");
                return Err("CGVirtualDisplay is unavailable".into());
            }
            self.events.push("display-created");
            Ok(Box::new(FakePrivateDisplay {
                events: self.events.clone(),
            }))
        }

        fn launch_browser(&self, command: Command) -> io::Result<StartedBrowser> {
            self.commands.lock().unwrap().push(
                command
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect(),
            );
            if self.launch_fails {
                self.events.push("launch-failed");
                return Err(io::Error::other("LaunchServices refused"));
            }
            self.alive.store(true, Ordering::Release);
            self.events.push("browser-launched");
            let alive = Arc::clone(&self.alive);
            Ok(StartedBrowser {
                browser: SpawnedBrowser {
                    process: Box::new(FakeProcess {
                        alive: Arc::clone(&self.alive),
                        events: self.events.clone(),
                    }),
                    stdout: None,
                    stderr: None,
                },
                alive: Box::new(move || alive.load(Ordering::Acquire)),
            })
        }

        fn windows_on_owner_displays(&self, _pid: u32, private: &ScreenRect) -> u32 {
            assert_eq!(private.x, 1728);
            self.windows_outside.load(Ordering::Acquire)
        }

        fn fallback_session(&self) -> Box<dyn DisplaySession> {
            self.events.push("fallback");
            Box::new(FakeDisplay::new(self.events.clone(), 0))
        }
    }

    fn wait_for(events: &Events, event: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !events.all().iter().any(|seen| seen == event) {
            assert!(Instant::now() < deadline, "no {event}: {:?}", events.all());
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn start(platform: &Arc<FakePlatform>) -> Box<dyn DisplaySession> {
        VirtualDisplayProvider::new(Arc::clone(platform))
            .start(Instant::now() + Duration::from_secs(5))
            .expect("start")
    }

    #[test]
    fn the_browser_opens_on_the_private_display_which_is_removed_after_it_stops() {
        let platform = Arc::new(FakePlatform::default());
        let mut session = start(&platform);
        let launch = session.browser_launch().clone();
        assert!(launch.pages_open_in_background);
        assert!(launch
            .args
            .contains(&"--window-position=1728,-900".to_string()));
        assert!(launch.args.contains(&"--window-size=1440,900".to_string()));
        assert!(launch.args.contains(&"--no-startup-window".to_string()));
        assert!(session.streams_while_concealed(), "no reveal is needed");
        assert!(
            session.reveal().is_err(),
            "there is nothing to show on the desktop"
        );

        let mut spawned = session.spawn(Command::new("chrome")).expect("spawn");
        assert_eq!(
            session.observed_visibility(),
            ObservedVisibility::IsolatedDisplay
        );
        assert!(spawned.process.terminate());
        // The browser has stopped; whichever of the watcher and the session
        // stop gets there first removes the display, and only once.
        assert!(session.terminate());
        assert!(session.terminate(), "terminate is idempotent");
        assert_eq!(
            platform.events.all(),
            [
                "display-created",
                "browser-launched",
                "browser-stop",
                "display-removed"
            ]
        );
    }

    #[test]
    fn a_crashed_browser_has_its_display_removed_without_waiting_for_release() {
        let platform = Arc::new(FakePlatform::default());
        let mut session = start(&platform);
        let _spawned = session.spawn(Command::new("chrome")).expect("spawn");
        platform.alive.store(false, Ordering::Release);
        wait_for(&platform.events, "display-removed");
        assert!(session.terminate());
        assert_eq!(
            platform.events.all(),
            ["display-created", "browser-launched", "display-removed"]
        );
    }

    #[test]
    fn a_window_on_the_owner_display_is_reported_not_hidden() {
        let platform = Arc::new(FakePlatform::default());
        let mut session = start(&platform);
        let _spawned = session.spawn(Command::new("chrome")).expect("spawn");
        platform.windows_outside.store(1, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(5);
        while session.observed_visibility() != ObservedVisibility::Visible {
            assert!(Instant::now() < deadline, "the stray window was not seen");
            thread::sleep(Duration::from_millis(10));
        }
        platform.windows_outside.store(0, Ordering::Release);
        thread::sleep(WATCH_PERIOD * 2);
        assert_eq!(
            session.observed_visibility(),
            ObservedVisibility::Visible,
            "what the owner could have seen is not forgotten"
        );
        assert!(session.terminate());
    }

    #[test]
    fn without_a_private_display_the_fallback_session_is_used() {
        let platform = Arc::new(FakePlatform {
            create_fails: true,
            ..FakePlatform::default()
        });
        let mut session = start(&platform);
        assert!(session.terminate());
        assert_eq!(
            platform.events.all(),
            ["display-create-failed", "fallback", "display-stop"]
        );
    }

    fn launch_spec<'a>(
        executable: &'a std::path::Path,
        profile: &'a std::path::Path,
    ) -> LaunchSpec<'a> {
        LaunchSpec {
            executable,
            profile_dir: profile,
            headless: false,
            display_backend: DisplayBackend::HiddenNative,
            deadline: Instant::now() + Duration::from_secs(5),
        }
    }

    #[test]
    fn a_failed_launch_removes_the_private_display() {
        let temp = tempfile::tempdir().expect("tempdir");
        let platform = Arc::new(FakePlatform {
            launch_fails: true,
            ..FakePlatform::default()
        });
        let launcher = BrowserLauncher::new(
            DisplayProviders::default()
                .with(Arc::new(VirtualDisplayProvider::new(Arc::clone(&platform)))),
        );
        let executable = temp.path().join("chrome");
        let failure = launcher
            .launch(&launch_spec(&executable, temp.path()))
            .err()
            .expect("launch fails");
        assert_eq!(failure.error.code, SURFACE_START_FAILED);
        assert!(failure.unstopped.is_none());
        assert_eq!(
            platform.events.all(),
            ["display-created", "launch-failed", "display-removed"]
        );
    }

    #[test]
    fn a_browser_that_exits_before_it_is_ready_stops_before_its_display() {
        let temp = tempfile::tempdir().expect("tempdir");
        let platform = Arc::new(FakePlatform::default());
        let launcher = BrowserLauncher::new(
            DisplayProviders::default()
                .with(Arc::new(VirtualDisplayProvider::new(Arc::clone(&platform)))),
        );
        // The fake browser never serves DevTools; it "crashes" right away.
        let crasher = Arc::clone(&platform);
        let crash = thread::spawn(move || {
            wait_for(&crasher.events, "browser-launched");
            crasher.alive.store(false, Ordering::Release);
        });
        let executable = temp.path().join("chrome");
        let failure = launcher
            .launch(&launch_spec(&executable, temp.path()))
            .err()
            .expect("launch fails");
        crash.join().expect("crash thread");
        assert_ne!(failure.error.code, BROWSER_DISPLAY_UNAVAILABLE);
        assert!(failure.unstopped.is_none());
        let events = platform.events.all();
        assert_eq!(events.first().map(String::as_str), Some("display-created"));
        assert_eq!(events.last().map(String::as_str), Some("display-removed"));
        assert_eq!(
            events
                .iter()
                .filter(|event| *event == "display-removed")
                .count(),
            1
        );
        // The launch passed the private display's geometry to the browser.
        let commands = platform.commands.lock().unwrap();
        assert!(commands[0].contains(&"--window-position=1728,-900".to_string()));
    }
}
