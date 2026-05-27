using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PRISM.Visualiser.Orchestrator.Process;

/// <summary>
/// Thin wrapper around the Win32 Job Object API. The orchestrator
/// self-assigns its own process to a job with
/// <see cref="JobObjectLimitFlags.KillOnJobClose"/> set, then calls
/// <see cref="AddProcess"/> for every child it spawns (Cirrus, UE) so
/// the entire subtree dies if the orchestrator is killed for any reason
/// — including the OS terminating us because the parent agent walked
/// away. This replaces signal-based child management which is unreliable
/// on Windows.
///
/// Phase B only exercises the self-assign path; Phase E/F will call
/// <see cref="AddProcess"/> with the Cirrus + UE PIDs.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class JobObject : IDisposable
{
    private SafeHandle _handle;
    private bool _disposed;

    private JobObject(SafeHandle handle)
    {
        _handle = handle;
    }

    /// <summary>
    /// Create a Job Object with KILL_ON_JOB_CLOSE and assign the current
    /// process to it. If the orchestrator dies for any reason — graceful
    /// exit, crash, OS kill — every process the orchestrator later adds
    /// to this job is terminated immediately.
    /// </summary>
    public static JobObject CreateAndAssignSelf(string? name = null)
    {
        var handleRaw = NativeMethods.CreateJobObject(IntPtr.Zero, name);
        if (handleRaw == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "CreateJobObject failed");
        }

        var handle = new JobObjectSafeHandle(handleRaw);
        var job = new JobObject(handle);

        // Configure KILL_ON_JOB_CLOSE up front so a hard exit between
        // here and AddProcess does not leak the soon-to-be-children.
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = JobObjectLimitFlags.KillOnJobClose,
            },
        };

        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var infoPtr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, infoPtr, fDeleteOld: false);
            var ok = NativeMethods.SetInformationJobObject(
                handleRaw,
                JobObjectInfoClass.ExtendedLimitInformation,
                infoPtr,
                (uint)size);
            if (!ok)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(infoPtr);
        }

        var self = System.Diagnostics.Process.GetCurrentProcess();
        if (!NativeMethods.AssignProcessToJobObject(handleRaw, self.Handle))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "AssignProcessToJobObject failed for current process");
        }

        return job;
    }

    /// <summary>
    /// Assign an additional child process (by PID) to this job. Phase
    /// E/F will call this for the Cirrus signalling server and the UE
    /// streamer the moment they start.
    /// </summary>
    public void AddProcess(int pid)
    {
        ThrowIfDisposed();
        using var p = System.Diagnostics.Process.GetProcessById(pid);
        if (!NativeMethods.AssignProcessToJobObject(_handle.DangerousGetHandle(), p.Handle))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                $"AssignProcessToJobObject failed for pid {pid}");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _handle.Dispose();
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    // -------------------------------------------------------------
    // P/Invoke surface
    // -------------------------------------------------------------

    [Flags]
    private enum JobObjectLimitFlags : uint
    {
        KillOnJobClose = 0x2000,
    }

    private enum JobObjectInfoClass
    {
        ExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public JobObjectLimitFlags LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(
            IntPtr hJob,
            JobObjectInfoClass infoClass,
            IntPtr lpJobObjectInfo,
            uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);
    }

    private sealed class JobObjectSafeHandle : SafeHandle
    {
        public JobObjectSafeHandle(IntPtr h) : base(IntPtr.Zero, ownsHandle: true)
        {
            SetHandle(h);
        }

        public override bool IsInvalid => handle == IntPtr.Zero;

        protected override bool ReleaseHandle()
        {
            return NativeMethods.CloseHandle(handle);
        }
    }
}
