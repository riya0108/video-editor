import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Cloud, Loader2, LogOut, Mail, X, Zap } from "lucide-react";
import { auth, cancelCloudJob, CloudApiError, cloudAuthAvailable, fetchMe, hasConsent, listCloudJobs, rememberConsent, sendMagicLink, signOut, submitJob, waitForJob, type CloudJob, type CloudMe } from "../../../../lib/cloud/client";
import { Modal } from "./StudioChrome";

/**
 * CLOUD ACCOUNT UI (Phase 4 M0): the account + daily credits in the Studio top bar, the first-use consent notice, and
 * `runCloudJob` — the one way editor features start cloud work (consent -> human check -> submit -> wait -> refresh
 * credits). Local editing never depends on any of this: when the server has no cloud setup, it all stays hidden.
 */

export interface CloudFeatureInfo {
  id: string;
  label: string;
  /** What leaves the device, for the consent notice ("the text you enter", "your voice sample and script"...). */
  sends: string;
  uploadsMedia: boolean;
}

interface CloudCtx {
  me: CloudMe | null;
  refresh: () => Promise<void>;
  runCloudJob: (feature: CloudFeatureInfo, params: unknown, opts?: { uploads?: string[]; onUpdate?: (j: CloudJob) => void; signal?: AbortSignal }) => Promise<CloudJob>;
  openAccount: () => void;
}

const Ctx = createContext<CloudCtx | null>(null);
export const useCloud = () => useContext(Ctx);

export function CloudProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<CloudMe | null>(null);
  const [consent, setConsent] = useState<{ feature: CloudFeatureInfo; resolve: (ok: boolean) => void } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await fetchMe());
    } catch {
      setMe((m) => m ?? { configured: false, signedIn: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sub = auth()?.auth.onAuthStateChange(() => void refresh());
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 60_000);
    return () => {
      sub?.data.subscription.unsubscribe();
      clearInterval(t);
    };
  }, [refresh]);

  const runCloudJob: CloudCtx["runCloudJob"] = useCallback(
    async (feature, params, opts = {}) => {
      if (!hasConsent(feature.id)) {
        const ok = await new Promise<boolean>((resolve) => setConsent({ feature, resolve }));
        setConsent(null);
        if (!ok) throw new DOMException("Cancelled", "AbortError");
        rememberConsent(feature.id);
      }
      try {
        const job = await submitJob(feature.id, params, { consent: true, uploads: opts.uploads });
        void refresh(); // the reservation shows immediately
        const done = await waitForJob(job.id, opts.onUpdate, opts.signal);
        return done;
      } catch (e) {
        if (e instanceof CloudApiError && e.code === "sign_in_required") setAccountOpen(true);
        throw e;
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  return (
    <Ctx.Provider value={{ me, refresh, runCloudJob, openAccount: () => setAccountOpen(true) }}>
      {children}
      <Modal open={!!consent} title={`Use ${consent?.feature.label ?? "cloud AI"}?`} onClose={() => consent?.resolve(false)} testId="cloud-consent">
        {consent && (
          <div className="flex flex-col gap-4 text-body-sm">
            <p>
              This feature runs on Clipbench's servers, not in your browser. <b>{consent.feature.sends}</b> will be sent to them and to our AI providers to process it.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-(--color-text-muted)">
              {consent.feature.uploadsMedia && <li>Uploaded media is deleted within 24 hours.</li>}
              <li>It isn't used to train AI models, and it isn't shared for any other purpose.</li>
              <li>Everything else in the editor keeps running only on your device.</li>
            </ul>
            <p className="text-caption text-(--color-text-muted)">
              Details: <a href="/privacy" target="_blank" rel="noopener" className="underline">privacy</a> · <a href="/terms" target="_blank" rel="noopener" className="underline">terms</a>
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => consent.resolve(false)} className="rounded-lg border border-(--color-border) px-3 py-1.5 font-medium">
                Not now
              </button>
              <button type="button" onClick={() => consent.resolve(true)} className="rounded-lg bg-primary-500 px-3 py-1.5 font-semibold text-white" data-testid="cloud-consent-accept">
                Continue
              </button>
            </div>
          </div>
        )}
      </Modal>
      <AccountDialog open={accountOpen} onClose={() => setAccountOpen(false)} me={me} />
    </Ctx.Provider>
  );
}

const hours = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.max(1, Math.round(sec / 60))} min`);

/** Top-bar entry: the credits pill + account. Hidden when the server has no cloud setup. */
export function CloudAccountButton() {
  const cloud = useCloud();
  const me = cloud?.me;
  if (!cloud || !me?.configured || !me.credits) return null;
  const low = me.credits.available <= Math.max(1, me.credits.allowance * 0.1);
  return (
    <button
      type="button"
      onClick={() => cloud.openAccount()}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-semibold tabular-nums transition-colors ${low ? "border-warning-500/50 text-warning-600" : "border-(--color-border) hover:bg-(--color-bg-subtle)"}`}
      title={`${me.credits.available} of ${me.credits.allowance} free AI credits left today — refills in ${hours(me.credits.resetsInSec)}`}
      data-testid="cloud-credits"
    >
      <Zap className="h-3.5 w-3.5 text-accent-500" fill="currentColor" />
      {me.credits.available}
      {!me.signedIn && <span className="ml-0.5 font-medium text-(--color-text-muted)">· Sign in</span>}
    </button>
  );
}

function AccountDialog({ open, onClose, me }: { open: boolean; onClose: () => void; me: CloudMe | null }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" | "error"; message?: string }>({ kind: "idle" });
  const c = me?.credits;
  return (
    <Modal open={open} title={me?.signedIn ? "Your account" : "Free AI credits"} onClose={onClose} testId="cloud-account">
      <div className="flex flex-col gap-5 text-body-sm">
        {c && (
          <div className="rounded-xl bg-(--color-bg-subtle) p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-h3 font-semibold tabular-nums">
                {c.available} <span className="text-body-sm font-normal text-(--color-text-muted)">of {c.allowance} credits left today</span>
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-(--color-border)">
              <div className="h-full bg-accent-500" style={{ width: `${(c.available / Math.max(1, c.allowance)) * 100}%` }} />
            </div>
            <p className="mt-2 text-caption text-(--color-text-muted)">
              Refills to {c.allowance} at 00:00 UTC (in {hours(c.resetsInSec)}). Unused credits don't carry over. Credits are only used by cloud AI features — everything else is free and unlimited.
            </p>
          </div>
        )}
        {me?.signedIn ? (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success-500" /> Signed in as <b>{me.email}</b>
            </span>
            <button type="button" onClick={() => void signOut().then(onClose)} className="flex items-center gap-1.5 rounded-lg border border-(--color-border) px-3 py-1.5 font-medium">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        ) : cloudAuthAvailable ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setState({ kind: "sending" });
              const r = await sendMagicLink(email.trim());
              setState(r.ok ? { kind: "sent" } : { kind: "error", message: r.error });
            }}
          >
            <p>
              <b>Sign in for 50 free credits a day</b> (10 without an account) and to use voice, dubbing and lip sync. No password — we email you a sign-in link.
            </p>
            {state.kind === "sent" ? (
              <p className="flex items-center gap-2 rounded-lg bg-success-500/10 px-3 py-2">
                <Mail className="h-4 w-4" /> Check {email} for your sign-in link. You can close this.
              </p>
            ) : (
              <div className="flex gap-2">
                <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="min-w-0 flex-1 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2" aria-label="Email address" />
                <button type="submit" disabled={state.kind === "sending"} className="flex items-center gap-1.5 rounded-lg bg-primary-500 px-4 py-2 font-semibold text-white disabled:opacity-60">
                  {state.kind === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Send link
                </button>
              </div>
            )}
            {state.kind === "error" && <p className="text-danger-600">{state.message}</p>}
          </form>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The Cloud section of the AI drawer: balance, recent jobs, and (development) the pipeline check
// ---------------------------------------------------------------------------

const ECHO: CloudFeatureInfo = { id: "echo", label: "Cloud check", sends: "The text you enter", uploadsMedia: false };

export function CloudPanel() {
  const cloud = useCloud();
  const [jobs, setJobs] = useState<CloudJob[]>([]);
  const [text, setText] = useState("Hello from Clipbench");
  const [running, setRunning] = useState<CloudJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const me = cloud?.me;
  const reload = useCallback(() => {
    if (me?.configured) void listCloudJobs().then((r) => setJobs(r.jobs)).catch(() => {});
  }, [me?.configured]);
  useEffect(reload, [reload]);
  useEffect(() => () => abort.current?.abort(), []);
  if (!cloud || !me?.configured) return null;
  const echo = me.features?.find((f) => f.id === "echo");

  return (
    <section className="mx-2 mt-4 flex flex-col gap-3 rounded-xl border border-(--color-border) p-3 text-caption" data-testid="cloud-panel">
      <h3 className="flex items-center gap-1.5 font-semibold">
        <Cloud className="h-4 w-4 text-accent-500" /> Cloud AI
        <span className="ml-auto font-normal text-(--color-text-muted) tabular-nums">{me.credits?.available ?? 0} credits left today</span>
      </h3>
      <p className="text-(--color-text-muted)">Dubbing, voice cloning, AI images and script-to-video arrive here next. They use your free daily credits.</p>
      {echo && (
        <div className="flex flex-col gap-2 rounded-lg bg-(--color-bg-subtle) p-2.5">
          <p className="font-medium">Pipeline check (development)</p>
          <div className="flex gap-1.5">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} className="min-w-0 flex-1 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1" aria-label="Text to send" />
            <button
              type="button"
              disabled={!!running || !text.trim()}
              className="rounded-md bg-primary-500 px-2.5 py-1 font-semibold text-white disabled:opacity-50"
              data-testid="cloud-echo-run"
              onClick={async () => {
                setError(null);
                abort.current = new AbortController();
                try {
                  const done = await cloud.runCloudJob(ECHO, { text }, { onUpdate: setRunning, signal: abort.current.signal });
                  if (done.status === "failed") setError(done.error ?? "The job failed; your credits were refunded.");
                } catch (e) {
                  if ((e as { name?: string }).name !== "AbortError") setError((e as Error).message);
                } finally {
                  setRunning(null);
                  reload();
                }
              }}
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Run (1 credit)"}
            </button>
          </div>
          {running && <p className="text-(--color-text-muted)">Job {running.status}…</p>}
          {error && <p className="text-danger-600" role="alert">{error}</p>}
        </div>
      )}
      {jobs.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="cloud-jobs">
          {jobs.slice(0, 6).map((j) => (
            <li key={j.id} className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${j.status === "succeeded" ? "bg-success-500" : j.status === "failed" ? "bg-danger-500" : j.status === "cancelled" ? "bg-(--color-border-strong)" : "bg-warning-500"}`} />
              <span className="flex-1 truncate">
                {j.feature} · {j.status}
                {j.status === "succeeded" && typeof (j.result as { text?: string })?.text === "string" ? ` · “${(j.result as { text: string }).text}”` : ""}
              </span>
              <span className="tabular-nums text-(--color-text-faint)">{j.status === "succeeded" ? `${j.chargedCredits} cr` : j.status === "failed" || j.status === "cancelled" ? "refunded" : `${j.estCredits} cr held`}</span>
              {j.status === "queued" && (
                <button type="button" onClick={() => void cancelCloudJob(j.id).then(() => (reload(), cloud.refresh()))} className="text-(--color-text-muted)" aria-label="Cancel job">
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
