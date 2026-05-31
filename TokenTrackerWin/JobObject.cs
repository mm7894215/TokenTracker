using System.Runtime.InteropServices;

namespace TokenTrackerWin;

/// <summary>
/// Wraps a Windows Job Object configured with KILL_ON_JOB_CLOSE. Any process
/// assigned to it is terminated when this job's handle closes — including when
/// our own process dies abnormally (crash, Task Manager "End task"), because the
/// kernel closes all handles on process teardown.
///
/// This is the Windows-correct way to guarantee the spawned Node server never
/// outlives the tray app. The graceful tray "Quit" path also kills the process
/// tree explicitly; the job is the backstop for the non-graceful paths.
/// </summary>
internal sealed class JobObject : IDisposable
{
    private nint _handle;

    public JobObject()
    {
        _handle = CreateJobObject(nint.Zero, null);
        if (_handle == nint.Zero) return; // jobs unavailable — fall back to best-effort tree kill

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        int length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        nint infoPtr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, infoPtr, false);
            SetInformationJobObject(
                _handle,
                JobObjectExtendedLimitInformation,
                infoPtr,
                (uint)length);
        }
        finally
        {
            Marshal.FreeHGlobal(infoPtr);
        }
    }

    /// <summary>Assign a process so it dies with this job. Safe to call when jobs are unavailable.</summary>
    public bool Assign(nint processHandle)
    {
        if (_handle == nint.Zero || processHandle == nint.Zero) return false;
        return AssignProcessToJobObject(_handle, processHandle);
    }

    public void Dispose()
    {
        if (_handle != nint.Zero)
        {
            CloseHandle(_handle); // closing the last handle triggers KILL_ON_JOB_CLOSE
            _handle = nint.Zero;
        }
    }

    // ── P/Invoke ───────────────────────────────────────────────────────

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateJobObject(nint lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        nint hJob, int infoType, nint lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(nint hJob, nint hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint hObject);

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
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
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryUsed;
        public nuint PeakJobMemoryUsed;
    }
}
