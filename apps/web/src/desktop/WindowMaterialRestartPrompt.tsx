import { isSystemMaterialRequested, type DesktopWindowMaterialReason } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { onClientSettingsPersisted, useClientSettings } from "../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";

export function canRelaunchForWindowMaterial(): boolean {
  return typeof window !== "undefined" && Boolean(window.desktopBridge?.relaunchForWindowMaterial);
}

export function WindowMaterialRestartDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    const relaunch = window.desktopBridge?.relaunchForWindowMaterial;
    if (!relaunch) return;
    setRestarting(true);
    setError(null);
    try {
      await relaunch();
    } catch {
      setError("Couldn't restart T3 Code. Quit and reopen it to use Liquid Glass.");
      setRestarting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (restarting) return;
        onOpenChange(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart T3 Code to use Liquid Glass?</AlertDialogTitle>
          <AlertDialogDescription>
            Liquid Glass applies once T3 Code reopens its window. Agents and terminals running in T3
            Code on this computer will stop.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogClose disabled={restarting} render={<Button variant="outline" />}>
            Later
          </AlertDialogClose>
          <Button disabled={restarting} onClick={() => void restart()}>
            {restarting ? (
              <>
                <Spinner size="sm" />
                Restarting…
              </>
            ) : (
              "Restart now"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const wantsSystemGlass = (
  settings: Parameters<typeof isSystemMaterialRequested>[0] & { readonly glassOpacity: number },
) => isSystemMaterialRequested(settings) && settings.glassOpacity < 100;

// Counts saved changes from this window that turned system glass on. Saved writes only, so a
// failed "off" that rolls the switch back never reads as a new request.
let glassRequests = 0;
let handledGlassRequests = 0;
const glassRequestListeners = new Set<() => void>();
onClientSettingsPersisted((previous, next) => {
  if (wantsSystemGlass(previous) || !wantsSystemGlass(next)) return;
  glassRequests += 1;
  for (const listener of glassRequestListeners) listener();
});
const subscribeGlassRequests = (listener: () => void) => {
  glassRequestListeners.add(listener);
  return () => {
    glassRequestListeners.delete(listener);
  };
};
const getGlassRequests = () => glassRequests;
const takeGlassRequest = () => {
  if (handledGlassRequests === glassRequests) return false;
  handledGlassRequests = glassRequests;
  return true;
};

/** Asks once per saved change that turns system glass on while the window needs a restart. */
export function WindowMaterialRestartPrompt({
  reason,
}: {
  readonly reason: DesktopWindowMaterialReason | null;
}) {
  const requests = useSyncExternalStore(subscribeGlassRequests, getGlassRequests);
  // A turn-on that saved after a newer turn-off was queued no longer reflects the choice.
  const wanted = useClientSettings(wantsSystemGlass);
  const [open, setOpen] = useState(false);
  if (open && reason !== null && reason !== "restart") setOpen(false);
  const due = requests !== handledGlassRequests && wanted && reason === "restart";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a modal must wait for a held slider's pointerup
  useEffect(() => {
    if (!due) return;
    let cancelled = false;
    const show = () => {
      if (!cancelled && takeGlassRequest()) setOpen(true);
    };
    if (document.querySelector("input[type='range']:active") === null) {
      queueMicrotask(show);
    } else {
      window.addEventListener("pointerup", show, { once: true });
    }
    return () => {
      cancelled = true;
      window.removeEventListener("pointerup", show);
    };
  }, [due]);

  return <WindowMaterialRestartDialog open={open} onOpenChange={setOpen} />;
}
