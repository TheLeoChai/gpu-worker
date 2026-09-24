using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Management;
using Timer = System.Windows.Forms.Timer;

namespace GpuWorkerTray
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool createdNew;
            using (Mutex m = new Mutex(true, "GpuWorkerTray-Mutex", out createdNew))
            {
                if (!createdNew) return;
                Application.EnableVisualStyles();
                Application.Run(new TrayContext());
            }
        }
    }

    class TrayContext : ApplicationContext
    {
        enum State { Stopped, RunningNoTs, RunningIdle, RunningBusy }

        readonly string workerDir = Application.StartupPath;
        readonly string nodeExe = @"C:\Program Files\nodejs\node.exe";
        readonly NotifyIcon tray;
        readonly Timer pollTimer;
        readonly MenuItem statusItem;
        readonly MenuItem jobItem;
        readonly MenuItem queueItem;
        readonly MenuItem startItem;
        readonly MenuItem stopItem;
        readonly MenuItem restartItem;
        readonly Dictionary<State, Icon> icons = new Dictionary<State, Icon>();
        readonly Dictionary<State, string> texts = new Dictionary<State, string>();
        State lastState = State.Stopped;
        string tsIp;
        DateTime lastTsQuery = DateTime.MinValue;
        string runningDesc;
        int queuedCount;
        string nextQueuedDesc;

        public TrayContext()
        {
            texts[State.Stopped] = "GPU Worker: stopped";
            texts[State.RunningNoTs] = "GPU Worker: running, NOT connected to Tailscale";
            texts[State.RunningIdle] = "GPU Worker: connected to Tailscale, waiting for jobs";
            texts[State.RunningBusy] = "GPU Worker: connected to Tailscale, job running";

            statusItem = new MenuItem(texts[State.Stopped]) { Enabled = false };
            jobItem = new MenuItem("Running: (unknown)") { Enabled = false };
            queueItem = new MenuItem("Queued: (unknown)") { Enabled = false };
            startItem = new MenuItem("Start", delegate { StartWorker(); });
            stopItem = new MenuItem("Stop", delegate { StopWorker(); });
            restartItem = new MenuItem("Restart", delegate { RestartWorker(); });
            MenuItem exitItem = new MenuItem("Exit", delegate { tray.Visible = false; Application.Exit(); });

            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add(statusItem);
            menu.MenuItems.Add(jobItem);
            menu.MenuItems.Add(queueItem);
            menu.MenuItems.Add("-");
            menu.MenuItems.Add(startItem);
            menu.MenuItems.Add(stopItem);
            menu.MenuItems.Add(restartItem);
            menu.MenuItems.Add("-");
            menu.MenuItems.Add(exitItem);

            tray = new NotifyIcon();
            tray.Icon = GetIcon(State.Stopped);
            tray.Text = texts[State.Stopped];
            tray.ContextMenu = menu;
            tray.Visible = true;

            pollTimer = new Timer();
            pollTimer.Interval = 2000;
            pollTimer.Tick += Poll;
            pollTimer.Start();
            Poll(null, null);

            try
            {
                if (WorkerPids().Count == 0)
                {
                    Log("no worker process at launch; auto-starting");
                    StartWorker();
                }
            }
            catch (Exception ex)
            {
                Log("auto-start check failed: " + ex.Message);
            }
        }

        bool polling;

        async void Poll(object sender, EventArgs e)
        {
            // never stop the timer: a hung poll must not freeze status updates
            if (polling) return;
            polling = true;
            try
            {
                State s = await Task.Run(new Func<State>(CheckState));
                ApplyState(s);
            }
            catch
            {
                ApplyState(State.Stopped);
            }
            finally
            {
                polling = false;
            }
        }

        void ApplyState(State s)
        {
            bool changed = s != lastState;
            lastState = s;
            if (changed) Log("state -> " + texts[s]);

            string tip = texts[s];
            if (s == State.RunningBusy)
                tip = "GPU Worker: job running" + (queuedCount > 0 ? ", " + queuedCount + " queued" : "");
            else if (s == State.RunningIdle && queuedCount > 0)
                tip = "GPU Worker: idle, " + queuedCount + " queued";

            tray.Icon = GetIcon(s);
            tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            statusItem.Text = texts[s];
            jobItem.Text = "Running: " + (s == State.Stopped ? "(none)" : (runningDesc ?? "(none)"));
            queueItem.Text = "Queued: " + queuedCount + (nextQueuedDesc != null && queuedCount > 0 ? " (next: " + nextQueuedDesc + ")" : "");
            startItem.Enabled = (s == State.Stopped);
            stopItem.Enabled = (s != State.Stopped);
            restartItem.Enabled = (s != State.Stopped);
        }

        void Log(string msg)
        {
            try
            {
                File.AppendAllText(Path.Combine(workerDir, "tray.log"),
                    DateTime.Now.ToString("HH:mm:ss") + " " + msg + Environment.NewLine);
            }
            catch { }
        }

        State CheckState()
        {
            bool local = HealthOk("http://127.0.0.1:4120/health");
            if (!local) { runningDesc = null; queuedCount = 0; nextQueuedDesc = null; return State.Stopped; }

            LoadJobSnapshot();

            string ip = GetTsIp();
            bool ts = false;
            if (ip != null) ts = HealthOk("http://" + ip + ":4120/health");
            if (!ts) { tsIp = null; lastTsQuery = DateTime.MinValue; return State.RunningNoTs; }

            return runningDesc != null ? State.RunningBusy : State.RunningIdle;
        }

        void LoadJobSnapshot()
        {
            runningDesc = null;
            queuedCount = 0;
            nextQueuedDesc = null;
            try
            {
                string path = Path.Combine(workerDir, "jobs.json");
                if (!File.Exists(path)) return;
                JavaScriptSerializer ser = new JavaScriptSerializer();
                Dictionary<string, object> data = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                if (data == null) return;

                object runId;
                string rid = data.TryGetValue("runningId", out runId) && runId != null ? runId.ToString() : null;
                List<object> queue = null;
                object qo;
                if (data.TryGetValue("queueOrder", out qo)) queue = qo as List<object>;
                Dictionary<string, object> jobs = data["jobs"] as Dictionary<string, object>;
                if (jobs == null) return;

                if (rid != null)
                {
                    object jobObj;
                    if (jobs.TryGetValue(rid, out jobObj))
                    {
                        Dictionary<string, object> job = jobObj as Dictionary<string, object>;
                        if (job != null && string.Equals(job["status"] as string, "running"))
                            runningDesc = DescribeJob(job);
                    }
                }
                if (queue != null && queue.Count > 0)
                {
                    queuedCount = queue.Count;
                    object firstObj;
                    if (queue[0] != null && jobs.TryGetValue(queue[0].ToString(), out firstObj))
                    {
                        Dictionary<string, object> first = firstObj as Dictionary<string, object>;
                        if (first != null) nextQueuedDesc = DescribeJob(first);
                    }
                }
            }
            catch (Exception ex)
            {
                Log("jobs.json read failed: " + ex.Message);
            }
        }

        string DescribeJob(Dictionary<string, object> job)
        {
            string repo = job["repo"] as string;
            if (repo == null) repo = "?";
            string cmd = job["command"] as string;
            if (cmd == null) cmd = "";
            cmd = cmd.Replace("\r", " ").Replace("\n", " ").Trim();
            if (cmd.Length > 44) cmd = cmd.Substring(0, 44) + "...";
            return repo + ": " + cmd;
        }

        bool HealthOk(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "HEAD";
                req.Proxy = null;
                req.Timeout = 900;
                req.ReadWriteTimeout = 900;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode < 500;
                }
            }
            catch (Exception ex)
            {
                Log("health " + url + " failed: " + ex.Message);
                return false;
            }
        }

        string GetTsIp()
        {
            if (tsIp != null && (DateTime.UtcNow - lastTsQuery).TotalSeconds < 60) return tsIp;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("tailscale.exe", "ip -4");
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    Task<string> readTask = p.StandardOutput.ReadToEndAsync();
                    if (!readTask.Wait(3000))
                    {
                        try { p.Kill(); } catch { }
                        Log("tailscale ip -4 timed out");
                        tsIp = null;
                        lastTsQuery = DateTime.UtcNow;
                        return null;
                    }
                    Match m = Regex.Match(readTask.Result, @"100\.\d+\.\d+\.\d+");
                    tsIp = m.Success ? m.Value : null;
                }
            }
            catch (Exception ex)
            {
                Log("tailscale ip -4 failed: " + ex.Message);
                tsIp = null;
            }
            lastTsQuery = DateTime.UtcNow;
            return tsIp;
        }

        void StartWorker()
        {
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"" + Path.Combine(workerDir, "start-worker.cmd") + "\"");
            psi.WorkingDirectory = workerDir;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }

        List<int> WorkerPids()
        {
            List<int> pids = new List<int>();
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'"))
            {
                foreach (ManagementObject mo in searcher.Get())
                {
                    string cl = mo["CommandLine"] as string;
                    if (cl != null && cl.Contains("server.js") && !cl.Contains("Adobe"))
                    {
                        pids.Add(Convert.ToInt32(mo["ProcessId"]));
                    }
                    mo.Dispose();
                }
            }
            return pids;
        }

        void StopWorker()
        {
            foreach (int pid in WorkerPids())
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo("taskkill.exe", "/PID " + pid + " /T /F");
                    psi.CreateNoWindow = true;
                    psi.UseShellExecute = false;
                    using (Process.Start(psi)) { }
                }
                catch { }
            }
        }

        void RestartWorker()
        {
            StopWorker();
            for (int i = 0; i < 20; i++)
            {
                if (WorkerPids().Count == 0) break;
                Thread.Sleep(300);
            }
            Thread.Sleep(500);
            StartWorker();
        }

        Icon GetIcon(State s)
        {
            Icon cached;
            if (icons.TryGetValue(s, out cached)) return cached;
            Color c;
            switch (s)
            {
                case State.RunningIdle: c = Color.FromArgb(46, 204, 113); break;   // green
                case State.RunningBusy: c = Color.FromArgb(52, 152, 219); break;   // blue
                case State.RunningNoTs: c = Color.FromArgb(230, 145, 30); break;   // orange
                default: c = Color.FromArgb(200, 55, 55); break;                    // red
            }
            Bitmap bmp = new Bitmap(16, 16);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (SolidBrush b = new SolidBrush(c)) g.FillEllipse(b, 1, 1, 14, 14);
                using (Pen p = new Pen(Color.FromArgb(70, 70, 70))) g.DrawEllipse(p, 1, 1, 14, 14);
            }
            cached = Icon.FromHandle(bmp.GetHicon());
            icons[s] = cached;
            return cached;
        }
    }
}