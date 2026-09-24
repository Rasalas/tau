/**
 * Bonjour on Windows through the system's own mDNS responder: the DNS-SD
 * functions of `dnsapi.dll` (Windows 10 1809 and later), called from Windows
 * PowerShell with a small C# shim. Both scripts write JSON lines; the announce
 * script withdraws when its stdin closes, so it never outlives the host.
 */

const DNS_SD_SHIM = String.raw`
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TauDnsSd {
  const uint Pending = 9506;
  [StructLayout(LayoutKind.Sequential)]
  struct Instance { public IntPtr Name; public IntPtr Host; public IntPtr Ip4; public IntPtr Ip6; public ushort Port; public ushort Priority; public ushort Weight; public uint Count; public IntPtr Keys; public IntPtr Values; public uint Interface; }
  [StructLayout(LayoutKind.Sequential)]
  struct RegisterRequest { public uint Version; public uint Interface; public IntPtr Instance; public IntPtr Callback; public IntPtr Context; public IntPtr Credentials; public int Unicast; }
  [StructLayout(LayoutKind.Sequential)]
  struct QueryRequest { public uint Version; public uint Interface; public IntPtr Query; public IntPtr Callback; public IntPtr Context; }
  [StructLayout(LayoutKind.Sequential)]
  struct Record { public IntPtr Next; public IntPtr Name; public ushort Type; public ushort Length; public uint Flags; public uint Ttl; public uint Reserved; public IntPtr Data; }
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void InstanceDone(uint status, IntPtr context, IntPtr instance);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void RecordsDone(uint status, IntPtr context, IntPtr records);
  [DllImport("dnsapi.dll", CharSet = CharSet.Unicode)] static extern IntPtr DnsServiceConstructInstance(string service, string host, IntPtr ip4, IntPtr ip6, ushort port, ushort priority, ushort weight, uint count, string[] keys, string[] values);
  [DllImport("dnsapi.dll")] static extern void DnsServiceFreeInstance(IntPtr instance);
  [DllImport("dnsapi.dll")] static extern uint DnsServiceRegister(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")] static extern uint DnsServiceDeRegister(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")] static extern uint DnsServiceBrowse(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")] static extern uint DnsServiceBrowseCancel(IntPtr cancel);
  [DllImport("dnsapi.dll")] static extern uint DnsServiceResolve(IntPtr request, IntPtr cancel);
  [DllImport("dnsapi.dll")] static extern void DnsRecordListFree(IntPtr records, int freeType);

  static readonly InstanceDone registered = OnRegistered;
  static readonly RecordsDone browsed = OnBrowsed;
  static readonly InstanceDone resolved = OnResolved;
  static readonly ManualResetEvent answered = new ManualResetEvent(false);
  static readonly object gate = new object();
  static readonly HashSet<string> seen = new HashSet<string>();
  static readonly List<string> lines = new List<string>();
  static IntPtr registration = IntPtr.Zero;
  static uint registerStatus;
  static string registeredName;
  static int resolving;

  static IntPtr Pin(object value) { IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(value)); Marshal.StructureToPtr(value, p, false); return p; }
  static IntPtr Zeroed(int size) { IntPtr p = Marshal.AllocHGlobal(size); for (int i = 0; i < size; i++) Marshal.WriteByte(p, i, 0); return p; }

  public static string Register(string service, string host, int port, string[] keys, string[] values) {
    IntPtr instance = DnsServiceConstructInstance(service, host, IntPtr.Zero, IntPtr.Zero, (ushort)port, 0, 0, (uint)keys.Length, keys, values);
    if (instance == IntPtr.Zero) return "DnsServiceConstructInstance failed";
    RegisterRequest request = new RegisterRequest();
    request.Version = 1; request.Instance = instance; request.Callback = Marshal.GetFunctionPointerForDelegate(registered);
    registration = Pin(request);
    uint status = DnsServiceRegister(registration, IntPtr.Zero);
    if (status != Pending) return "DnsServiceRegister failed with " + status;
    if (!answered.WaitOne(15000)) return "the system did not confirm the announcement";
    return registerStatus == 0 ? null : "the system refused the announcement (" + registerStatus + ")";
  }
  public static string Name { get { return registeredName; } }
  static void OnRegistered(uint status, IntPtr context, IntPtr instance) {
    registerStatus = status;
    if (instance != IntPtr.Zero) {
      Instance found = (Instance)Marshal.PtrToStructure(instance, typeof(Instance));
      registeredName = Marshal.PtrToStringUni(found.Name);
      DnsServiceFreeInstance(instance);
    }
    answered.Set();
  }
  public static void Deregister() {
    if (registration == IntPtr.Zero) return;
    answered.Reset();
    if (DnsServiceDeRegister(registration, IntPtr.Zero) == Pending) answered.WaitOne(3000);
  }

  public static string[] Browse(string query, int milliseconds) {
    QueryRequest request = new QueryRequest();
    request.Version = 1; request.Query = Marshal.StringToHGlobalUni(query); request.Callback = Marshal.GetFunctionPointerForDelegate(browsed);
    IntPtr cancel = Zeroed(IntPtr.Size);
    uint status = DnsServiceBrowse(Pin(request), cancel);
    if (status != Pending) throw new Exception("DnsServiceBrowse failed with " + status);
    Thread.Sleep(milliseconds);
    DnsServiceBrowseCancel(cancel);
    DateTime until = DateTime.UtcNow.AddSeconds(2);
    while (DateTime.UtcNow < until) { lock (gate) { if (resolving == 0) break; } Thread.Sleep(50); }
    lock (gate) { return lines.ToArray(); }
  }
  static void OnBrowsed(uint status, IntPtr context, IntPtr records) {
    if (records == IntPtr.Zero) return;
    try {
      for (IntPtr p = records; p != IntPtr.Zero; ) {
        Record record = (Record)Marshal.PtrToStructure(p, typeof(Record));
        if (record.Type == 12 && record.Data != IntPtr.Zero) Resolve(Marshal.PtrToStringUni(record.Data));
        p = record.Next;
      }
    } finally { DnsRecordListFree(records, 1); }
  }
  static void Resolve(string name) {
    lock (gate) { if (!seen.Add(name)) return; resolving++; }
    QueryRequest request = new QueryRequest();
    request.Version = 1; request.Query = Marshal.StringToHGlobalUni(name); request.Callback = Marshal.GetFunctionPointerForDelegate(resolved);
    if (DnsServiceResolve(Pin(request), Zeroed(IntPtr.Size)) != Pending) { lock (gate) { resolving--; } }
  }
  static void OnResolved(uint status, IntPtr context, IntPtr instance) {
    try {
      if (status != 0 || instance == IntPtr.Zero) return;
      Instance found = (Instance)Marshal.PtrToStructure(instance, typeof(Instance));
      List<string> addresses = new List<string>();
      if (found.Ip4 != IntPtr.Zero) { byte[] v4 = new byte[4]; Marshal.Copy(found.Ip4, v4, 0, 4); addresses.Add(new IPAddress(v4).ToString()); }
      if (found.Ip6 != IntPtr.Zero) { byte[] v6 = new byte[16]; Marshal.Copy(found.Ip6, v6, 0, 16); addresses.Add(new IPAddress(v6).ToString()); }
      StringBuilder json = new StringBuilder("{\"name\":").Append(Quote(Marshal.PtrToStringUni(found.Name)));
      json.Append(",\"hostName\":").Append(Quote(Marshal.PtrToStringUni(found.Host))).Append(",\"port\":").Append(found.Port);
      json.Append(",\"addresses\":[");
      for (int i = 0; i < addresses.Count; i++) json.Append(i > 0 ? "," : "").Append(Quote(addresses[i]));
      json.Append("],\"txt\":{");
      for (int i = 0; i < found.Count; i++) {
        string key = Marshal.PtrToStringUni(Marshal.ReadIntPtr(found.Keys, i * IntPtr.Size));
        string value = Marshal.PtrToStringUni(Marshal.ReadIntPtr(found.Values, i * IntPtr.Size));
        json.Append(i > 0 ? "," : "").Append(Quote(key)).Append(":").Append(Quote(value));
      }
      json.Append("}}");
      lock (gate) { lines.Add(json.ToString()); }
    } finally {
      if (instance != IntPtr.Zero) DnsServiceFreeInstance(instance);
      lock (gate) { resolving--; }
    }
  }
  public static string Quote(string text) {
    StringBuilder quoted = new StringBuilder("\"");
    foreach (char c in text ?? "") {
      if (c == '"' || c == '\\') quoted.Append('\\').Append(c);
      else if (c < 32 || c > 126) quoted.Append("\\u").Append(((int)c).ToString("x4"));
      else quoted.Append(c);
    }
    return quoted.Append('"').ToString();
  }
}
`;

/** Announces `$request` and waits for stdin to close, then withdraws. */
export const WINDOWS_ANNOUNCE_SCRIPT = `
$failure = [TauDnsSd]::Register($request.instance, $request.host, [int]$request.port, [string[]]@($request.keys), [string[]]@($request.values))
if ($failure) { [Console]::Out.WriteLine('{"event":"error","message":' + [TauDnsSd]::Quote($failure) + '}'); exit 1 }
[Console]::Out.WriteLine('{"event":"announced","name":' + [TauDnsSd]::Quote([TauDnsSd]::Name) + '}')
while ($null -ne [Console]::In.ReadLine()) { }
[TauDnsSd]::Deregister()
`;

/** Lists `$request.query` for `$request.milliseconds`, one JSON line per resolved instance. */
export const WINDOWS_BROWSE_SCRIPT = `
foreach ($line in [TauDnsSd]::Browse($request.query, [int]$request.milliseconds)) { [Console]::Out.WriteLine($line) }
`;

/** PowerShell arguments that run `script` with `$request` set; `-EncodedCommand` keeps quoting out of the command line. */
export function windowsScriptArguments(script: string, request: unknown): string[] {
  const json = JSON.stringify(request).replace(/'/gu, "''");
  const source = [
    "$ErrorActionPreference = 'Stop'",
    `$request = ConvertFrom-Json '${json}'`,
    `Add-Type -TypeDefinition @'\n${DNS_SD_SHIM}\n'@`,
    script,
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")];
}
