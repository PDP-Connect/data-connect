// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//! A Windows Job Object that kills every process in it when its last handle
//! closes.
//!
//! The supervisor holds one job per sidecar. When the app dies for any reason
//! (Task Manager, crash, power-off of the session) the kernel closes the app's
//! handle and terminates the sidecar and its descendants. Windows has no
//! parent-death signal for plain child processes, so this is the kernel-level
//! backstop that `PR_SET_PDEATHSIG` is on Linux.

use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(super) struct KillOnCloseJob(HANDLE);

// A job handle is a kernel object handle: any thread may use or close it.
unsafe impl Send for KillOnCloseJob {}

impl KillOnCloseJob {
    /// Creates a kill-on-close job and puts `child` in it.
    ///
    /// The child is already running, so a process it started before this call
    /// returns is not in the job. The window is the time between `spawn()` and
    /// this call. Nested jobs (Windows 8 and later) let the assignment succeed
    /// even when the app itself runs inside a job.
    pub(super) fn adopt(child: &Child) -> io::Result<Self> {
        // SAFETY: plain Win32 calls with valid arguments. `job` owns the
        // handle from creation on, so every early return closes it.
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);

            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                return Err(io::Error::last_os_error());
            }

            if AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this value and closed exactly once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}
