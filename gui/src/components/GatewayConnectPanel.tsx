import { useState } from "react";
import { apiErrorMessage } from "../api-error";
import { IconGlobe } from "../icons";
import { useT } from "../i18n";
import { Notice, Switch } from "../ui";

export interface ConnectedGateway {
  id: string;
  label: string;
  kind: string;
  protocol: string;
  platform: string;
  baseUrl: string;
  maskedKey: string;
  costMultiplier: number | null;
  models: string[];
  defaultModel: string | null;
  refreshed: boolean;
}

interface ConnectResponse {
  success?: true;
  connected?: ConnectedGateway[];
  imported?: string[];
  failures?: Array<{ maskedKey: string; reason: string; message: string }>;
}

/**
 * One-paste onboarding: the user pastes whatever their gateway dashboard gave
 * them and the server identifies the endpoint, the product and the models.
 * Raw keys are posted once and never echoed back — responses carry masked keys.
 */
export default function GatewayConnectPanel({
  apiBase,
  onConnected,
}: {
  apiBase: string;
  onConnected: (names: string[]) => void;
}) {
  const t = useT();
  const [paste, setPaste] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [setDefault, setSetDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ConnectedGateway[] | null>(null);

  const connect = async () => {
    if (!paste.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch(`${apiBase}/api/gateways/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paste,
          ...(baseUrl.trim() ? { baseUrls: [baseUrl.trim()] } : {}),
          allowPrivateNetwork,
          setDefault,
        }),
      });
      if (!response.ok) {
        setError(await apiErrorMessage(response, t("gateway.connect.failed")));
        return;
      }
      const body = await response.json() as ConnectResponse;
      const connected = body.connected ?? [];
      setResult(connected);
      setPaste("");
      if (body.imported?.length) onConnected(body.imported);
    } catch {
      setError(t("gateway.error.network"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gateway-connect-panel">
      <div className="gateway-import-eyebrow"><IconGlobe />{t("gateway.connect.eyebrow")}</div>
      <h4>{t("gateway.connect.title")}</h4>
      <p className="gateway-import-description">{t("gateway.connect.subtitle")}</p>

      <textarea
        className="input"
        rows={4}
        spellCheck={false}
        autoComplete="off"
        value={paste}
        placeholder={t("gateway.connect.placeholder")}
        onChange={event => { setPaste(event.target.value); setError(""); }}
      />

      <div className="gateway-connect-options">
        <input
          className="input"
          value={baseUrl}
          spellCheck={false}
          placeholder={t("gateway.connect.baseUrlPlaceholder")}
          onChange={event => setBaseUrl(event.target.value)}
        />
        <label className="gateway-connect-toggle">
          <Switch on={setDefault} onClick={() => setSetDefault(!setDefault)} label={t("gateway.connect.setDefault")} />
          <span>{t("gateway.connect.setDefault")}</span>
        </label>
        <label className="gateway-connect-toggle">
          <Switch
            on={allowPrivateNetwork}
            onClick={() => setAllowPrivateNetwork(!allowPrivateNetwork)}
            label={t("modal.allowPrivateNetwork")}
          />
          <span>{t("modal.allowPrivateNetwork")}</span>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!paste.trim() || busy}
          onClick={() => void connect()}
        >
          {busy ? t("gateway.connect.busy") : t("gateway.connect.action")}
        </button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}
      {result && result.length > 0 && (
        <Notice tone="ok">
          <ul className="gateway-connect-result">
            {result.map(gateway => (
              <li key={gateway.id}>
                <strong>{gateway.id}</strong>
                {gateway.refreshed ? ` · ${t("gateway.connect.refreshed")}` : ""}
                {" · "}{gateway.kind} · {gateway.protocol}
                {gateway.costMultiplier !== null ? ` · ×${gateway.costMultiplier}` : ""}
                <br />
                <span className="muted">
                  {gateway.baseUrl} · {gateway.maskedKey} · {t("gateway.connect.models", { n: gateway.models.length })}
                  {gateway.defaultModel ? ` · ${gateway.defaultModel}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Notice>
      )}
    </section>
  );
}
