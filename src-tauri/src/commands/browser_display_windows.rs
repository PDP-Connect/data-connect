// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `hidden-native` on Windows: the browser runs on the owner's desktop with
// every top-level window of its process tree hidden.
//
// Measured on GitHub's windows-latest runner with Chrome 155 (divan entry
// "background connector browsers can stay out of the user's face",
// follow-up 4):
// - A browser started normally shows and activates its window. A hidden
//   initial show state (STARTUPINFO) is ignored by Chrome. Cloaking another
//   process's window with DwmSetWindowAttribute is refused.
// - Hiding each window with ShowWindow(SW_HIDE) as soon as a WinEvent hook
//   reports it keeps it off screen except for one or two 5 ms samples, and
//   screencast frames and input keep working while hidden.
// - Pages opened in the background never take the foreground; see
//   `cdp_relay`.
//
// Windows are matched by process id against the browser's process tree, so
// the owner's own browser windows are never touched. Negative coordinates,
// minimising and separate desktops are not used: they move or restyle the
// window, or break Windows Hello and native dialogs.

use super::{
    spawn_child, BrowserDisplayLaunch, ConcealmentTracker, DisplayBackend, DisplayProvider,
    DisplaySession, ObservedVisibility, SpawnedBrowser,
};
use std::cell::RefCell;
use std::collections::HashSet;
use std::io;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumWindows, GetAncestor, GetWindowThreadProcessId, IsWindowVisible,
    MsgWaitForMultipleObjects, PeekMessageW, PostThreadMessageW, ShowWindow, TranslateMessage,
    EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, GA_ROOT, MSG, OBJID_WINDOW, PM_REMOVE, QS_ALLINPUT,
    SW_HIDE, SW_SHOWNOACTIVATE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_QUIT,
};

/// How often every window of the browser is checked, in addition to the
/// event hook. Catches windows whose events were missed.
const SWEEP_PERIOD_MS: u32 = 50;

pub(crate) struct HiddenNativeProvider;

impl DisplayProvider for HiddenNativeProvider {
    fn backend(&self) -> DisplayBackend {
        DisplayBackend::HiddenNative
    }

    fn start(&self, _deadline: std::time::Instant) -> Result<Box<dyn DisplaySession>, String> {
        Ok(Box::new(HiddenNativeSession {
            launch: BrowserDisplayLaunch {
                args: vec!["--no-startup-window".into()],
                pages_open_in_background: true,
                ..BrowserDisplayLaunch::default()
            },
            watch: Arc::new(Watch::default()),
            watcher: None,
        }))
    }
}

#[derive(Default)]
struct Watch {
    tracker: Mutex<ConcealmentTracker>,
    /// Windows this backend hid, shown again by `reveal`.
    hidden: Mutex<Vec<isize>>,
    thread_id: AtomicU32,
}

struct HiddenNativeSession {
    launch: BrowserDisplayLaunch,
    watch: Arc<Watch>,
    watcher: Option<JoinHandle<()>>,
}

impl DisplaySession for HiddenNativeSession {
    fn browser_launch(&self) -> &BrowserDisplayLaunch {
        &self.launch
    }

    fn spawn(&mut self, command: Command) -> io::Result<SpawnedBrowser> {
        let spawned = spawn_child(command)?;
        let root = spawned.process.id();
        let watch = Arc::clone(&self.watch);
        let (ready, started) = mpsc::channel();
        self.watcher = Some(
            thread::Builder::new()
                .name("browser-conceal".into())
                .spawn(move || watch_and_conceal(root, &watch, ready))?,
        );
        // Windows the browser opens before the hook exists are found by the
        // watcher's first sweep, which runs before it reports ready.
        started
            .recv()
            .map_err(|_| io::Error::other("The window watcher did not start"))??;
        Ok(spawned)
    }

    fn observed_visibility(&self) -> ObservedVisibility {
        self.watch
            .tracker
            .lock()
            .map_or(ObservedVisibility::Unknown, |tracker| tracker.visibility())
    }

    fn reveal(&mut self) -> Result<(), String> {
        if let Ok(mut tracker) = self.watch.tracker.lock() {
            tracker.reveal();
        }
        let hidden = self
            .watch
            .hidden
            .lock()
            .map(|mut hidden| std::mem::take(&mut *hidden))
            .unwrap_or_default();
        if hidden.is_empty() {
            return Err("The browser has no window to show".into());
        }
        for window in hidden {
            // SAFETY: ShowWindow on a stale handle fails harmlessly.
            unsafe { ShowWindow(window as HWND, SW_SHOWNOACTIVATE) };
        }
        Ok(())
    }

    fn terminate(&mut self) -> bool {
        let thread_id = self.watch.thread_id.load(Ordering::Acquire);
        if thread_id != 0 {
            // SAFETY: posts WM_QUIT to the watcher's message queue.
            unsafe { PostThreadMessageW(thread_id, WM_QUIT, 0, 0) };
        }
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

/// State the out-of-context hook callback reaches. The callback runs on the
/// thread that installed the hook, inside its message loop, so a
/// thread-local is enough and no lock is held across Windows calls.
struct HookContext {
    root: u32,
    tree: HashSet<u32>,
    watch: Arc<Watch>,
}

thread_local! {
    static CONTEXT: RefCell<Option<HookContext>> = const { RefCell::new(None) };
}

fn watch_and_conceal(root: u32, watch: &Arc<Watch>, ready: mpsc::Sender<io::Result<()>>) {
    // SAFETY: plain Win32 calls; the hook is removed before this returns.
    let thread_id = unsafe { GetCurrentThreadId() };
    watch.thread_id.store(thread_id, Ordering::Release);
    CONTEXT.with(|context| {
        *context.borrow_mut() = Some(HookContext {
            root,
            tree: process_tree(root),
            watch: Arc::clone(watch),
        });
    });
    let hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_SHOW,
            std::ptr::null_mut(),
            Some(on_window_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if hook.is_null() {
        let _ = ready.send(Err(io::Error::last_os_error()));
        return;
    }
    sweep();
    let _ = ready.send(Ok(()));
    let mut quit = false;
    while !quit {
        // SAFETY: waits for input on this thread's queue or the timeout.
        unsafe { MsgWaitForMultipleObjects(0, std::ptr::null(), 0, SWEEP_PERIOD_MS, QS_ALLINPUT) };
        let mut message: MSG = unsafe { std::mem::zeroed() };
        // SAFETY: drains this thread's queue; the hook callback runs here.
        while unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
            if message.message == WM_QUIT {
                quit = true;
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        sweep();
    }
    unsafe { UnhookWinEvent(hook) };
    CONTEXT.with(|context| context.borrow_mut().take());
}

unsafe extern "system" fn on_window_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    window: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    if object != OBJID_WINDOW || child != 0 || window.is_null() {
        return;
    }
    if unsafe { GetAncestor(window, GA_ROOT) } != window {
        return;
    }
    CONTEXT.with(|context| {
        if let Some(context) = context.borrow_mut().as_mut() {
            let owner = window_process(window);
            if !context.tree.contains(&owner) {
                // A new browser process may own this window.
                context.tree = process_tree(context.root);
            }
            if context.tree.contains(&owner) {
                conceal(context, &[window]);
            }
        }
    });
}

/// Check every visible top-level window of the browser.
fn sweep() {
    CONTEXT.with(|context| {
        if let Some(context) = context.borrow_mut().as_mut() {
            context.tree = process_tree(context.root);
            let mut windows: Vec<HWND> = Vec::new();
            // SAFETY: the callback only pushes into `windows` for this call.
            unsafe {
                EnumWindows(
                    Some(collect_window),
                    (&mut windows as *mut Vec<HWND>) as LPARAM,
                )
            };
            let owned: Vec<HWND> = windows
                .into_iter()
                .filter(|window| context.tree.contains(&window_process(*window)))
                .collect();
            conceal(context, &owned);
        }
    });
}

unsafe extern "system" fn collect_window(window: HWND, windows: LPARAM) -> BOOL {
    // SAFETY: `windows` is the Vec passed by `sweep` for this enumeration.
    unsafe { (*(windows as *mut Vec<HWND>)).push(window) };
    1
}

/// Hide the visible ones among `windows` unless the browser was revealed.
fn conceal(context: &HookContext, windows: &[HWND]) {
    // SAFETY: IsWindowVisible on any handle is safe; stale ones are false.
    let visible: Vec<HWND> = windows
        .iter()
        .copied()
        .filter(|window| unsafe { IsWindowVisible(*window) } != 0)
        .collect();
    let Ok(mut tracker) = context.watch.tracker.lock() else {
        return;
    };
    if !tracker.observe(visible.len() as u32) {
        return;
    }
    drop(tracker);
    let mut hidden = context.watch.hidden.lock().ok();
    for window in visible {
        // SAFETY: hides another process's top-level window; it fails
        // harmlessly if the window is gone.
        unsafe { ShowWindow(window, SW_HIDE) };
        if let Some(hidden) = hidden.as_mut() {
            if !hidden.contains(&(window as isize)) {
                hidden.push(window as isize);
            }
        }
    }
}

fn window_process(window: HWND) -> u32 {
    let mut process = 0;
    // SAFETY: writes the owning process id into `process`.
    unsafe { GetWindowThreadProcessId(window, &mut process) };
    process
}

/// `root` and all of its descendants, by parent process id.
fn process_tree(root: u32) -> HashSet<u32> {
    let mut parents = Vec::new();
    // SAFETY: a process snapshot, closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot != INVALID_HANDLE_VALUE {
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }
        unsafe { CloseHandle(snapshot) };
    }
    descendants(root, &parents)
}

/// `root` and every process whose parent chain reaches it.
fn descendants(root: u32, parents: &[(u32, u32)]) -> HashSet<u32> {
    let mut tree = HashSet::from([root]);
    loop {
        let before = tree.len();
        for (process, parent) in parents {
            if tree.contains(parent) && *process != 0 {
                tree.insert(*process);
            }
        }
        if tree.len() == before {
            return tree;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tree_follows_parent_links_from_the_root_only() {
        let parents = [(10, 1), (11, 10), (12, 11), (20, 1), (21, 20)];
        assert_eq!(descendants(10, &parents), HashSet::from([10, 11, 12]));
        assert_eq!(descendants(99, &parents), HashSet::from([99]));
    }
}
