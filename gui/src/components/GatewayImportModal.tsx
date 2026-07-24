import { useEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage } from "../api-error";
import {
  buildGatewayImportRequest,
  createGatewayDraft,
  gatewayDraftIssue,
  MAX_GATEWAY_CONNECTIONS,
  type GatewayDraft,
  type GatewayDraftIssue,
  type GatewayImportPreview,
} from "../gateway-import";
import { IconGlobe, IconPlus, IconTrash, IconX } from "../icons";
import { useT, type TKey } from "../i18n";
import { Notice, Switch } from "../ui";

const ISSUE_KEYS: Record<GatewayDraftIssue, TKey> = {
  "missing-id": "gateway.error.missingId",
  "invalid-id": "gateway.error.invalidId",
  "duplicate-id": "gateway.error.duplicateId",
  "missing-base-url": "gateway.error.missingBaseUrl",
  "missing-api-key": "gateway.error.missingApiKey",
  "missing-env": "gateway.error.missingEnv",
  "invalid-model-profiles": "gateway.error.invalidModelProfiles",
};

export default function GatewayImportModal({
  apiBase,
  currentDefaultProvider,
  existingNames,
  onClose,
  onImported,
}: {
  apiBase: string;
  currentDefaultProvider: string;
  existingNames: string[];
  onClose: () => void;
  onImported: (names: string[]) => void;
}) {
  const t = useT();
  const [drafts, setDrafts] = useState<GatewayDraft[]>(() => [createGatewayDraft()]);
  const [defaultProvider, setDefaultProvider] = useState(currentDefaultProvider);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<GatewayImportPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"validate" | "import" | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const invalidatePreview = () => {
    setPreview(null);
    setError("");
  };

  const updateDraft = <K extends keyof GatewayDraft>(
    clientId: string,
    key: K,
    value: GatewayDraft[K],
  ) => {
    if (key === "id") {
      const previousId = drafts.find(draft => draft.clientId === clientId)?.id.trim();
      if (previousId) {
        setDefaultProvider(current => (
          current === previousId ? String(value).trim() || currentDefaultProvider : current
        ));
      }
    }
    setDrafts(current => current.map(draft => (
      draft.clientId === clientId ? { ...draft, [key]: value } : draft
    )));
    invalidatePreview();
  };

  const defaultOptions = useMemo(() => {
    const options = new Set([currentDefaultProvider, ...existingNames]);
    for (const draft of drafts) {
      if (draft.id.trim()) options.add(draft.id.trim());
    }
    return [...options];
  }, [currentDefaultProvider, drafts, existingNames]);

  const previewCapabilities = useMemo(() => {
    if (!preview) return null;
    return preview.connections.reduce((total, connection) => ({
      profiled: total.profiled + connection.profiledModels.length,
      fast: total.fast + connection.fastModels.length,
      reasoning: total.reasoning + connection.reasoningModels.length,
    }), { profiled: 0, fast: 0, reasoning: 0 });
  }, [preview]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const removeDraft = (clientId: string) => {
    const removedId = drafts.find(draft => draft.clientId === clientId)?.id.trim();
    if (removedId && defaultProvider === removedId) {
      setDefaultProvider(currentDefaultProvider);
    }
    setDrafts(current => current.filter(draft => draft.clientId !== clientId));
    invalidatePreview();
  };

  const addDraft = () => {
    setDrafts(current => [...current, createGatewayDraft()]);
    invalidatePreview();
  };

  const setNextDefaultProvider = (value: string) => {
    setDefaultProvider(value);
    invalidatePreview();
  };

  const setReplaceExisting = (value: boolean) => {
    setForce(value);
    invalidatePreview();
  };

  const request = async (dryRun: boolean) => {
    const issue = gatewayDraftIssue(drafts);
    if (issue) {
      setError(t(ISSUE_KEYS[issue]));
      return;
    }

    setBusy(dryRun ? "validate" : "import");
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/gateways/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGatewayImportRequest(drafts, {
          currentDefaultProvider,
          defaultProvider,
          force,
          dryRun,
        })),
      });
      if (!response.ok) {
        setPreview(null);
        setError(await apiErrorMessage(response, t("gateway.error.request")));
        return;
      }
      const result = await response.json() as GatewayImportPreview;
      if (dryRun) {
        setPreview(result);
      } else {
        onImported(result.imported ?? result.connections.map(connection => connection.id));
      }
    } catch {
      setPreview(null);
      setError(t("gateway.error.network"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gateway-import-title"
      aria-describedby="gateway-import-description"
      className="modal-overlay gateway-import-overlay"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="modal-card gateway-import-modal"
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-head gateway-import-head">
          <div>
            <div className="gateway-import-eyebrow"><IconGlobe />{t("gateway.eyebrow")}</div>
            <h3 id="gateway-import-title">{t("gateway.title")}</h3>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t("common.close")}
            onClick={onClose}
            disabled={!!busy}
          >
            <IconX />
          </button>
        </div>

        <p id="gateway-import-description" className="gateway-import-description">
          {t("gateway.subtitle")}
        </p>

        <div className="gateway-import-scroll">
          <div className="gateway-import-list">
            {drafts.map((draft, index) => (
              <fieldset className="gateway-connection" key={draft.clientId}>
                <legend className="sr-only">{t("gateway.connection", { n: index + 1 })}</legend>
                <div className="gateway-connection-head">
                  <div>
                    <span className="gateway-connection-index">{String(index + 1).padStart(2, "0")}</span>
                    <strong>{draft.label.trim() || draft.id.trim() || t("gateway.connection", { n: index + 1 })}</strong>
                  </div>
                  {drafts.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeDraft(draft.clientId)}
                      aria-label={t("gateway.removeAria", { n: index + 1 })}
                    >
                      <IconTrash />{t("common.remove")}
                    </button>
                  )}
                </div>

                <div className="gateway-field-grid">
                  <Field label={t("gateway.id")}>
                    <input
                      className="input"
                      value={draft.id}
                      onChange={event => updateDraft(draft.clientId, "id", event.target.value)}
                      placeholder={t("gateway.idPlaceholder")}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label={t("gateway.label")}>
                    <input
                      className="input"
                      value={draft.label}
                      onChange={event => updateDraft(draft.clientId, "label", event.target.value)}
                      placeholder={t("gateway.labelPlaceholder")}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label={t("gateway.kind")}>
                    <select
                      className="input"
                      value={draft.kind}
                      onChange={event => updateDraft(
                        draft.clientId,
                        "kind",
                        event.target.value as GatewayDraft["kind"],
                      )}
                    >
                      <option value="openai-compatible">{t("gateway.kind.openaiCompatible")}</option>
                      <option value="one-api">{t("gateway.kind.oneApi")}</option>
                      <option value="new-api">{t("gateway.kind.newApi")}</option>
                      <option value="sub2api">{t("gateway.kind.sub2api")}</option>
                    </select>
                  </Field>
                  <Field label={t("gateway.protocol")}>
                    <select
                      className="input"
                      value={draft.protocol}
                      onChange={event => updateDraft(
                        draft.clientId,
                        "protocol",
                        event.target.value as GatewayDraft["protocol"],
                      )}
                    >
                      <option value="chat-completions">{t("gateway.protocol.chatCompletions")}</option>
                      <option value="responses">{t("gateway.protocol.responses")}</option>
                    </select>
                  </Field>
                  <Field label={t("gateway.baseUrl")} className="gateway-span-2">
                    <input
                      className="input gateway-mono"
                      value={draft.baseUrl}
                      onChange={event => updateDraft(draft.clientId, "baseUrl", event.target.value)}
                      placeholder={t("gateway.baseUrlPlaceholder")}
                      inputMode="url"
                      autoComplete="url"
                    />
                  </Field>
                  <Field label={t("gateway.credential")}>
                    <select
                      className="input"
                      value={draft.credentialMode}
                      onChange={event => updateDraft(
                        draft.clientId,
                        "credentialMode",
                        event.target.value as GatewayDraft["credentialMode"],
                      )}
                    >
                      <option value="stored">{t("gateway.credential.stored")}</option>
                      <option value="env">{t("gateway.credential.env")}</option>
                      <option value="none">{t("gateway.credential.none")}</option>
                    </select>
                  </Field>
                  {draft.credentialMode === "stored" ? (
                    <Field label={t("gateway.apiKey")}>
                      <input
                        className="input gateway-mono"
                        type="password"
                        value={draft.apiKey}
                        onChange={event => updateDraft(draft.clientId, "apiKey", event.target.value)}
                        placeholder={t("gateway.apiKeyPlaceholder")}
                        autoComplete="new-password"
                      />
                    </Field>
                  ) : draft.credentialMode === "env" ? (
                    <Field label={t("gateway.env")}>
                      <input
                        className="input gateway-mono"
                        value={draft.apiKeyEnv}
                        onChange={event => updateDraft(draft.clientId, "apiKeyEnv", event.target.value)}
                        placeholder={t("gateway.envPlaceholder")}
                        autoCapitalize="characters"
                        autoComplete="off"
                      />
                    </Field>
                  ) : (
                    <div className="gateway-keyless-note">{t("gateway.keylessHint")}</div>
                  )}
                  <Field label={t("gateway.models")} className="gateway-span-2">
                    <textarea
                      className="input gateway-models-input"
                      rows={3}
                      value={draft.modelsText}
                      onChange={event => updateDraft(draft.clientId, "modelsText", event.target.value)}
                      placeholder={t("gateway.modelsPlaceholder")}
                    />
                    <span className="gateway-field-hint">{t("gateway.modelsHint")}</span>
                  </Field>
                  <Field label={t("gateway.defaultModel")} className="gateway-span-2">
                    <input
                      className="input gateway-mono"
                      value={draft.defaultModel}
                      onChange={event => updateDraft(draft.clientId, "defaultModel", event.target.value)}
                      placeholder={t("gateway.defaultModelPlaceholder")}
                      autoComplete="off"
                    />
                  </Field>
                </div>

                <details className="gateway-capabilities">
                  <summary>{t("gateway.capabilities")}</summary>
                  <Field label={t("gateway.capabilitiesJson")}>
                    <textarea
                      className="input gateway-model-profiles-input gateway-mono"
                      rows={8}
                      value={draft.modelProfilesText}
                      onChange={event => updateDraft(
                        draft.clientId,
                        "modelProfilesText",
                        event.target.value,
                      )}
                      placeholder={t("gateway.capabilitiesPlaceholder")}
                      spellCheck={false}
                    />
                    <span className="gateway-field-hint">{t("gateway.capabilitiesHint")}</span>
                  </Field>
                </details>

                <div className="gateway-options">
                  <OptionRow
                    title={t("gateway.liveModels")}
                    description={t("gateway.liveModelsHint")}
                    value={draft.liveModels}
                    onChange={value => updateDraft(draft.clientId, "liveModels", value)}
                  />
                  <OptionRow
                    title={t("gateway.privateNetwork")}
                    description={t("gateway.privateNetworkHint")}
                    value={draft.allowPrivateNetwork}
                    onChange={value => updateDraft(draft.clientId, "allowPrivateNetwork", value)}
                  />
                </div>
              </fieldset>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-ghost gateway-add"
            onClick={addDraft}
            disabled={drafts.length >= MAX_GATEWAY_CONNECTIONS}
          >
            <IconPlus />{t("gateway.add")}
          </button>

          <section className="gateway-import-settings" aria-labelledby="gateway-import-settings-title">
            <h4 id="gateway-import-settings-title">{t("gateway.importSettings")}</h4>
            <div className="gateway-field-grid">
              <Field label={t("gateway.defaultProvider")}>
                <select
                  className="input"
                  value={defaultProvider}
                  onChange={event => setNextDefaultProvider(event.target.value)}
                >
                  {defaultOptions.map(name => (
                    <option value={name} key={name}>{name}</option>
                  ))}
                </select>
              </Field>
              <OptionRow
                title={t("gateway.replace")}
                description={t("gateway.replaceHint")}
                value={force}
                onChange={setReplaceExisting}
                compact
              />
            </div>
          </section>

          {error && <Notice tone="err">{error}</Notice>}
          {preview && (
            <Notice tone="ok">
              <span>
                {t("gateway.validationOk", {
                  n: preview.connections.length,
                  replacements: preview.replacements.length,
                })}
              </span>
              {previewCapabilities && previewCapabilities.profiled > 0 && (
                <span className="gateway-validation-detail">
                  {t("gateway.validationCapabilities", {
                    profiled: previewCapabilities.profiled,
                    reasoning: previewCapabilities.reasoning,
                    fast: previewCapabilities.fast,
                  })}
                </span>
              )}
            </Notice>
          )}
        </div>

        <div className="gateway-import-actions">
          <span className="gateway-action-hint">
            {preview ? t("gateway.ready") : t("gateway.validateHint")}
          </span>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void request(true)}
              disabled={!!busy}
            >
              {busy === "validate" ? t("gateway.validating") : t("gateway.validate")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void request(false)}
              disabled={!preview || !!busy}
            >
              {busy === "import" ? t("gateway.importing") : t("gateway.import")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={className}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function OptionRow({
  title,
  description,
  value,
  onChange,
  compact = false,
}: {
  title: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <div className={`gateway-option${compact ? " gateway-option-compact" : ""}`}>
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <Switch on={value} onClick={() => onChange(!value)} label={title} />
    </div>
  );
}
