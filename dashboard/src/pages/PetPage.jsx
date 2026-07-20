import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FileArchive, Link2, Loader2, MonitorUp, Trash2, Upload, X, Zap } from "lucide-react";
import { ToggleSwitch, SegmentedControl } from "../components/settings/Controls.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { usePetSettings } from "../hooks/use-pet-settings.js";
import { usePetCatalog } from "../hooks/use-pet-catalog.js";
import { useNativeSettings } from "../hooks/use-native-settings.js";
import {
  importCodexPets,
  importPetPackage,
  installPetFromUrl,
  listCodexImportable,
  removePet,
} from "../lib/pets-api.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { ClawdAnimated } from "../ui/foundation/ClawdAnimated.jsx";
import { FadeIn } from "../ui/foundation/FadeIn.jsx";
import { showToast } from "../ui/components/Toast.jsx";

const CHARACTER_TINTS = {
  clawd: "from-oai-amber-50 dark:from-orange-950/70",
  sprout: "from-oai-brand-100 dark:from-emerald-950/70",
  byte: "from-oai-gray-200 dark:from-slate-800/70",
  ember: "from-orange-100 dark:from-orange-950/80",
};

/** Renders localized copy with the literal "codex-pets.net" turned into a link. */
function ImportSubtitle() {
  const text = copy("pet.import.subtitle");
  const site = "codex-pets.net";
  const index = text.indexOf(site);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <a
        href="https://codex-pets.net"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-oai-gray-400 underline-offset-2 transition-colors hover:text-oai-black dark:decoration-oai-gray-500 dark:hover:text-white"
      >
        {site}
      </a>
      {text.slice(index + site.length)}
    </>
  );
}

const PREVIEW_STATES = [
  { id: "idle-living", labelKey: "pet.state.calm" },
  { id: "working-thinking", labelKey: "pet.state.focus" },
  { id: "working-juggling", labelKey: "pet.state.multitask" },
  { id: "working-wizard", labelKey: "pet.state.streak" },
  { id: "happy", labelKey: "pet.state.celebrate" },
  { id: "sleeping", labelKey: "pet.state.rest" },
];

function CharacterCard({ character, selected, onSelect, onRemove, removeDisabled }) {
  const name = character.nameKey ? copy(character.nameKey) : character.displayName;
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "relative w-full overflow-hidden rounded-xl border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
          selected
            ? "border-oai-brand-500/40 bg-white dark:border-oai-brand-500/25 dark:bg-oai-gray-900/80"
            : "border-oai-gray-200/80 bg-white/55 hover:border-oai-gray-400 dark:border-oai-gray-800 dark:bg-oai-gray-950/55 dark:hover:border-oai-gray-600",
        )}
      >
        <div className={cn("absolute inset-0 bg-gradient-to-br to-transparent opacity-80 dark:opacity-55", CHARACTER_TINTS[character.id] || "from-oai-gray-200/80 dark:from-oai-gray-800/70")} />
        <div className="relative flex items-center gap-2.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center">
            <ClawdAnimated state="idle-living" character={character.id} pet={character} size={44} />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-oai-black dark:text-white">{name}</span>
            {character.spriteVersionNumber === 2 ? (
              <span className="shrink-0 rounded border border-oai-gray-300/80 px-1 text-[9px] font-semibold text-oai-gray-500 dark:border-oai-gray-600 dark:text-oai-gray-400">{copy("pet.format.v2")}</span>
            ) : null}
            {selected ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-oai-brand-500" aria-hidden /> : null}
          </div>
        </div>
      </button>
      {onRemove ? (
        <button
          type="button"
          disabled={removeDisabled}
          onClick={onRemove}
          aria-label={`${copy("pet.import.remove")} · ${name}`}
          className={cn(
            "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md border border-oai-gray-200/90 bg-white/95 text-oai-gray-500 transition-opacity hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-40 dark:border-oai-gray-700 dark:bg-oai-gray-900/95 dark:text-oai-gray-400 dark:hover:text-red-400",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function PetStage({ pet, state, onStateChange }) {
  const [lookDirectionIndex, setLookDirectionIndex] = useState(null);
  const spriteRef = useRef(null);
  const stateSpec = PREVIEW_STATES.find(function findState(item) {
    return item.id === state;
  });
  const stateLabel = copy(stateSpec?.labelKey || "pet.state.calm");
  return (
    <section
      className="relative flex min-h-[400px] flex-col overflow-hidden bg-oai-gray-50 dark:bg-oai-gray-950 sm:min-h-[440px] lg:min-h-[480px]"
      onPointerMove={(event) => {
        // V2 pets track the pointer across the whole stage (mirroring the desktop
        // pet watching the cursor across the screen), not just over the sprite.
        if (pet?.spriteVersionNumber !== 2 || !spriteRef.current) return;
        const rect = spriteRef.current.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        setLookDirectionIndex(Math.round(angle / 22.5) % 16);
      }}
      onPointerLeave={() => setLookDirectionIndex(null)}
    >
      <div
        className="absolute inset-0 opacity-[0.16] dark:opacity-[0.12]"
        style={{ backgroundImage: "radial-gradient(currentColor 0.7px, transparent 0.7px)", backgroundSize: "14px 14px" }}
        aria-hidden
      />
      <div className="relative flex items-center justify-between gap-3 px-5 pt-5">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-oai-gray-500 dark:text-oai-gray-400">
          {copy("pet.preview.states")}
        </span>
        <div className="flex items-center gap-2 rounded-full border border-black/5 bg-white/65 px-3 py-1.5 text-[11px] font-medium text-oai-gray-600 backdrop-blur-md dark:border-white/10 dark:bg-black/20 dark:text-oai-gray-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          {stateLabel}
        </div>
      </div>
      <div className="relative flex flex-1 items-center justify-center px-6 py-5">
        <div
          ref={spriteRef}
          className="relative flex h-52 w-52 items-center justify-center sm:h-56 sm:w-56 lg:h-64 lg:w-64"
        >
          {/* Pixel art upscales cleanly; a transform keeps the sprite responsive
              without re-deriving the atlas geometry from a JS media query. */}
          <div className="origin-bottom lg:scale-[1.18]">
            <ClawdAnimated
              state={state}
              character={pet?.id || "clawd"}
              pet={pet}
              size={190}
              lookDirectionIndex={lookDirectionIndex}
            />
          </div>
        </div>
      </div>
      <div className="relative border-t border-oai-gray-200/70 bg-white/85 px-3 py-2 dark:border-oai-gray-800 dark:bg-oai-gray-950/85">
        <div className="grid grid-cols-3 gap-1" aria-label={copy("pet.preview.states")}>
          {PREVIEW_STATES.map((previewState) => (
            <button
              key={previewState.id}
              type="button"
              onClick={() => onStateChange(previewState.id)}
              aria-pressed={state === previewState.id}
              className={cn(
                "flex min-h-10 flex-col items-center justify-center gap-1 rounded-lg px-1.5 text-xs transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500",
                state === previewState.id
                  ? "font-semibold text-oai-black dark:text-white"
                  : "font-medium text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
              )}
            >
              <span>{copy(previewState.labelKey)}</span>
              <span
                className={cn(
                  "h-1 w-1 rounded-full transition-colors duration-200",
                  state === previewState.id ? "bg-oai-black dark:bg-white" : "bg-transparent",
                )}
                aria-hidden
              />
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// Modal picker showing Codex pets as sprite-preview cards (same visual language as
// "Choose your companion"), with multi-select import.
function CodexImportModal({ pets: importable, busy, error, onImport, onClose }) {
  const [picked, setPicked] = useState(() => new Set());

  const togglePick = (id) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allPicked = importable.length !== 0 && picked.size === importable.length;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/15 backdrop-blur-md dark:bg-black/40 animate-tt-fade-in" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6">
          <Dialog.Popup className="relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-oai-gray-200/50 bg-white/95 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-oai-gray-900/95 animate-tt-modal">
        <div className="flex items-start justify-between gap-3 border-b border-oai-gray-200/70 px-5 py-4 dark:border-oai-gray-800">
          <div className="min-w-0">
            <Dialog.Title className="text-base font-semibold">{copy("pet.codex.title")}</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
              {copy("pet.codex.subtitle")}
            </Dialog.Description>
          </div>
          <Dialog.Close
            type="button"
            disabled={busy}
            aria-label={copy("pet.codex.close")}
            className="shrink-0 rounded-full border border-oai-gray-200/60 p-1.5 text-oai-gray-500 transition-colors hover:text-oai-black disabled:opacity-40 dark:border-oai-gray-800/60 dark:text-oai-gray-400 dark:hover:text-white"
          >
            <X size={16} />
          </Dialog.Close>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {importable.length === 0 ? (
            <p className="py-8 text-center text-sm text-oai-gray-400 dark:text-oai-gray-500">{copy("pet.codex.empty")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {importable.map((pet) => (
                <CharacterCard
                  key={pet.id}
                  character={pet}
                  selected={picked.has(pet.id)}
                  onSelect={() => togglePick(pet.id)}
                />
              ))}
            </div>
          )}
          {error ? <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-oai-gray-200/70 px-5 py-3 dark:border-oai-gray-800">
          <button
            type="button"
            disabled={busy || importable.length === 0}
            onClick={() => setPicked(allPicked ? new Set() : new Set(importable.map((pet) => pet.id)))}
            className="text-xs font-medium text-oai-gray-500 underline-offset-2 hover:underline disabled:opacity-40 dark:text-oai-gray-400"
          >
            {copy("pet.codex.select_all")}
          </button>
          <button
            type="button"
            disabled={busy || picked.size === 0}
            onClick={() => onImport([...picked])}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-oai-black px-4 text-xs font-semibold text-white transition-colors disabled:bg-oai-gray-200 disabled:text-oai-gray-400 dark:bg-white dark:text-black dark:disabled:bg-oai-gray-800 dark:disabled:text-oai-gray-500"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {picked.size > 0 ? `${copy("pet.codex.import")} · ${picked.size}` : copy("pet.codex.import")}
          </button>
        </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PetPage() {
  const { available, settings, setSetting } = usePetSettings();
  const { pets, loading: catalogLoading, available: catalogAvailable, refresh } = usePetCatalog();
  const [importUrl, setImportUrl] = useState("");
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  // Codex pets available to reverse-import (read-only from the Codex app).
  const [codexImportable, setCodexImportable] = useState([]);
  const [codexModalOpen, setCodexModalOpen] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState("");
  const [previewState, setPreviewState] = useState("idle-living");
  // Auto-cycle the preview until the user picks a state themselves — a manual
  // choice must stick, so the first click stops the rotation for this visit.
  const [autoRotate, setAutoRotate] = useState(true);
  const selectedCharacter = settings.character || "clawd";
  const nativeSettings = useNativeSettings();
  const menuBarPetActive = nativeSettings.settings?.menuBarIconStyle === "pet";
  const selectedPet = pets.find((pet) => pet.id === selectedCharacter) || pets[0];
  // A long codex-pets.net download deserves live feedback, and failures must not
  // read like successes — success confirms via toast, errors stay inline by the form.
  const importLine = importBusy
    ? { kind: "busy", text: copy("pet.import.busy") }
    : (importError ? { kind: "error", text: importError } : null);
  const hasCodexImportable = codexImportable.length !== 0;

  useEffect(() => {
    if (!catalogLoading && pets.length > 0 && !pets.some((pet) => pet.id === selectedCharacter)) {
      setSetting("character", "clawd");
    }
  }, [catalogLoading, pets, selectedCharacter, setSetting]);

  async function runImport(operation, successMessage = copy("pet.import.success")) {
    setImportBusy(true);
    setImportError("");
    try {
      const result = await operation();
      await refresh();
      if (result?.pet?.id) setSetting("character", result.pet.id);
      showToast({ title: successMessage, timeout: 4000 });
      setImportUrl("");
    } catch (error) {
      setImportError(error?.message || copy("pet.import.failed"));
    } finally {
      setImportBusy(false);
    }
  }

  const refreshCodexImportable = useCallback(async () => {
    if (!catalogAvailable) { setCodexImportable([]); return; }
    try {
      const data = await listCodexImportable();
      setCodexImportable(data.importable);
    } catch {
      setCodexImportable([]);
    }
  }, [catalogAvailable]);

  useEffect(() => { refreshCodexImportable(); }, [refreshCodexImportable]);

  async function importFromCodex(ids) {
    setCodexBusy(true);
    setCodexError("");
    try {
      await importCodexPets(ids);
      await refresh();
      await refreshCodexImportable();
      showToast({ title: copy("pet.codex.imported"), timeout: 4000 });
      return true;
    } catch (error) {
      setCodexError(error?.message || copy("pet.import.failed"));
      return false;
    } finally {
      setCodexBusy(false);
    }
  }

  useEffect(() => {
    if (!autoRotate) return undefined;
    const timer = window.setInterval(() => {
      setPreviewState((current) => {
        const index = PREVIEW_STATES.findIndex((item) => item.id === current);
        return PREVIEW_STATES[(index + 1) % PREVIEW_STATES.length].id;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRotate]);

  const sizeOptions = [
    { value: "small", label: copy("pet.size.small") },
    { value: "medium", label: copy("pet.size.medium") },
    { value: "large", label: copy("pet.size.large") },
  ];

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-14 pt-8 sm:pt-10">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <FadeIn y={12}>
            <header className="mb-8">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{copy("pet.page.title")}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
                {copy("pet.page.subtitle")}
              </p>
            </header>
          </FadeIn>

          <FadeIn y={12} delay={0.04}>
            <div className="overflow-hidden rounded-[28px] border border-oai-gray-200 bg-white/75 dark:border-oai-gray-800 dark:bg-oai-gray-900/60 lg:grid lg:grid-cols-[1.12fr_0.88fr]">
              <PetStage
                pet={selectedPet}
                state={previewState}
                onStateChange={(state) => {
                  setAutoRotate(false);
                  setPreviewState(state);
                }}
              />

              <aside className="flex flex-col border-t border-oai-gray-200 p-5 dark:border-oai-gray-800 lg:min-h-[480px] lg:border-l lg:border-t-0">
                <section aria-labelledby="pet-character-title">
                  <div>
                    <h2 id="pet-character-title" className="text-sm font-semibold">
                      {copy("pet.characters.title")}
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
                      {copy("pet.characters.subtitle")}
                    </p>
                  </div>
                  <div className="mt-4 grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1 -mr-1">
                    {pets.map((character) => (
                      <CharacterCard
                        key={character.id}
                        character={character}
                        selected={selectedCharacter === character.id}
                        onSelect={() => setSetting("character", character.id)}
                        removeDisabled={importBusy}
                        onRemove={catalogAvailable && character.custom
                          ? () => runImport(async () => {
                            await removePet(character.id);
                            if (selectedCharacter === character.id) setSetting("character", "clawd");
                            return null;
                          }, copy("pet.import.removed"))
                          : undefined}
                      />
                    ))}
                  </div>
                  {nativeSettings.available ? (
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-oai-gray-200/70 bg-oai-gray-50/60 px-3 py-2.5 dark:border-oai-gray-800 dark:bg-oai-gray-900/40">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold">{copy("pet.menubar.title")}</p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
                          {copy("pet.menubar.hint")}
                        </p>
                      </div>
                      <ToggleSwitch
                        checked={menuBarPetActive}
                        onChange={() =>
                          nativeSettings.setSetting("menuBarIconStyle", menuBarPetActive ? "clawd" : "pet")
                        }
                        ariaLabel={copy("pet.menubar.title")}
                      />
                    </div>
                  ) : null}
                </section>

                {catalogAvailable ? (
                  <section className="mt-6 border-t border-oai-gray-200/70 pt-5 dark:border-oai-gray-800" aria-labelledby="pet-import-title">
                    <div className="flex items-center gap-2">
                      <Upload className="h-4 w-4 shrink-0 text-oai-gray-500" aria-hidden />
                      <h2 id="pet-import-title" className="text-sm font-semibold">{copy("pet.import.title")}</h2>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-oai-gray-500 dark:text-oai-gray-400">
                      <ImportSubtitle />
                    </p>
                    <form
                      className="mt-3 flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!importBusy && importUrl.trim()) runImport(() => installPetFromUrl(importUrl));
                      }}
                    >
                      <label className="relative flex min-w-0 flex-1 items-center">
                        <Link2 className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-oai-gray-400" aria-hidden />
                        <input
                          value={importUrl}
                          onChange={(event) => setImportUrl(event.target.value)}
                          aria-label={copy("pet.import.url_label")}
                          placeholder="codex-pets.net/#/pets/…"
                          className="h-9 w-full rounded-lg border border-oai-gray-200 bg-white pl-9 pr-3 text-xs outline-none focus:border-oai-brand-500 dark:border-oai-gray-700 dark:bg-oai-gray-950"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={importBusy || !importUrl.trim()}
                        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-oai-black px-3.5 text-xs font-semibold text-white transition-colors disabled:bg-oai-gray-200 disabled:text-oai-gray-400 dark:bg-white dark:text-black dark:disabled:bg-oai-gray-800 dark:disabled:text-oai-gray-500"
                      >
                        {importBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                        {copy("pet.import.add")}
                      </button>
                    </form>
                    <div className={cn("mt-2 grid gap-2", hasCodexImportable ? "grid-cols-2" : "grid-cols-1")}>
                      {hasCodexImportable ? (
                        <button
                          type="button"
                          disabled={importBusy || codexBusy}
                          onClick={() => { setCodexError(""); setCodexModalOpen(true); }}
                          className={cn(
                            "flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-oai-gray-300 text-xs font-medium text-oai-gray-500 transition-colors hover:border-oai-gray-500 hover:text-oai-black dark:border-oai-gray-600 dark:text-oai-gray-400 dark:hover:border-oai-gray-400 dark:hover:text-white",
                            (importBusy || codexBusy) && "pointer-events-none opacity-40",
                          )}
                        >
                          <ProviderIcon provider="codex" size={14} className="fill-current" />
                          {copy("pet.codex.browse")}
                        </button>
                      ) : null}
                      <label
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (importBusy) return;
                          const file = event.dataTransfer?.files?.[0];
                          if (file) runImport(() => importPetPackage(file));
                        }}
                        className={cn(
                          "flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-oai-gray-300 text-xs font-medium text-oai-gray-500 transition-colors hover:border-oai-gray-500 hover:text-oai-black dark:border-oai-gray-600 dark:text-oai-gray-400 dark:hover:border-oai-gray-400 dark:hover:text-white",
                          importBusy && "pointer-events-none opacity-40",
                        )}
                      >
                        <FileArchive className="h-3.5 w-3.5" aria-hidden />
                        {copy("pet.import.zip")}
                        <input
                          type="file"
                          accept=".zip,.codex-pet.zip,application/zip"
                          className="sr-only"
                          disabled={importBusy}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) runImport(() => importPetPackage(file));
                            event.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                    {importLine ? (
                      <p
                        role={importLine.kind === "error" ? "alert" : "status"}
                        className={cn(
                          "mt-2 text-xs",
                          importLine.kind === "error"
                            ? "text-red-600 dark:text-red-400"
                            : "text-oai-gray-500 dark:text-oai-gray-400",
                        )}
                      >
                        {importLine.text}
                      </p>
                    ) : null}
                    {codexModalOpen ? (
                      <CodexImportModal
                        pets={codexImportable}
                        busy={codexBusy}
                        error={codexError}
                        onClose={() => { if (!codexBusy) setCodexModalOpen(false); }}
                        onImport={async (ids) => {
                          const ok = await importFromCodex(ids);
                          if (ok) setCodexModalOpen(false);
                        }}
                      />
                    ) : null}
                  </section>
                ) : null}

                <section className="mt-6 border-t border-oai-gray-200/70 pt-5 dark:border-oai-gray-800">
                  <div className="flex items-center gap-2">
                    <MonitorUp className="h-4 w-4 text-oai-gray-500 dark:text-oai-gray-400" strokeWidth={1.75} aria-hidden />
                    <h2 className="text-sm font-semibold">{copy("pet.controls.title")}</h2>
                  </div>
                  <div className="mt-4 space-y-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm font-medium">{copy("pet.controls.show")}</div>
                      <ToggleSwitch
                        checked={settings.visible}
                        onChange={() => setSetting("visible", !settings.visible)}
                        disabled={!available}
                        ariaLabel={copy("pet.controls.show")}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="text-sm font-medium">{copy("pet.controls.size")}</div>
                      <div className="shrink-0">
                        <SegmentedControl
                          options={sizeOptions}
                          value={settings.size}
                          onChange={(value) => setSetting("size", value)}
                          disabled={!available}
                        />
                      </div>
                    </div>
                  </div>
                </section>
                {!available ? (
                  <div className="mt-6 flex gap-2 rounded-xl bg-oai-gray-100 p-3 text-xs leading-relaxed text-oai-gray-500 dark:bg-oai-gray-800/70 dark:text-oai-gray-400">
                    <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {copy("pet.controls.native_only")}
                  </div>
                ) : null}
              </aside>
            </div>
          </FadeIn>
        </div>
      </main>
    </div>
  );
}
