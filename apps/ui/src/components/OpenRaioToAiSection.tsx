import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckIcon, CopyIcon, PlugIcon, ShieldCheckIcon } from "../icons";
import { useSectionFocus } from "../hooks/useSectionFocus";
import { Switch } from "./Switch";
import "./SettingsSectionCard.css";
import "./OpenRaioToAiSection.css";

const PLACEHOLDER_PATH = "<RAIOPDF_MCP_PATH>";

// The repo is public, so this resolves even pre-release. Revisit if/when
// docs/MCP.md gets a hosted page of its own on raio.macrify.me.
const MCP_DOCS_URL = "https://github.com/Macrify-LLC/raiopdf/blob/main/docs/MCP.md";

const COPIED_LABEL_MS = 1600;

export interface OpenRaioToAiSectionProps {
  /** Whether the MCP connector's access gate is on. Off by default. */
  enabled: boolean;
  /** Called with the next state when the user flips the switch. The parent
   *  owns persistence (writing the OS/user-scoped enable flag); this
   *  component only reports intent. */
  onToggle: (next: boolean) => void;
  /**
   * Absolute path to the `raiopdf-mcp` binary, resolved by the shell at
   * runtime via Tauri resource resolution. `undefined`/`null` while that
   * resolution is still pending -- the connect blocks fall back to a
   * visible placeholder and disable Copy until a real path lands, rather
   * than let someone copy a config that can't work.
   */
  mcpPath?: string | null | undefined;
  /**
   * True for the render right after Preferences was opened via the
   * dedicated "Open Raio to AI..." menu item (as opposed to general
   * Preferences). The section scrolls itself into view and shows a brief
   * highlight, then calls `onFocusHandled` so the parent can drop the
   * flag back to `null`/`false`.
   */
  focused?: boolean | undefined;
  onFocusHandled?: (() => void) | undefined;
}

export function OpenRaioToAiSection({
  enabled,
  onToggle,
  mcpPath,
  focused = false,
  onFocusHandled,
}: OpenRaioToAiSectionProps) {
  const { sectionRef, showFocusRing } = useSectionFocus(focused, onFocusHandled);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedKey) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopiedKey(null), COPIED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copiedKey]);

  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopiedKey(key))
      .catch(() => {
        // Clipboard permission denied or unavailable in this webview --
        // the block underneath is still plain selectable text.
      });
  }, []);

  const pathResolved = Boolean(mcpPath);
  const resolvedOrPlaceholder = mcpPath ?? PLACEHOLDER_PATH;
  const desktopSnippet = buildClaudeDesktopSnippet(resolvedOrPlaceholder);
  const codeCommand = buildClaudeCodeCommand(resolvedOrPlaceholder);

  return (
    <section
      ref={sectionRef}
      id="open-raio-to-ai"
      className="settings-section open-raio-to-ai"
      aria-labelledby="open-raio-to-ai-heading"
      data-focused={showFocusRing ? "true" : undefined}
    >
      <header className="settings-section__header">
        <span className="settings-section__icon open-raio-to-ai__icon" aria-hidden="true">
          <PlugIcon size={18} />
        </span>
        <div className="settings-section__heading-group">
          <p className="settings-section__eyebrow">Bring your own AI</p>
          <h3 id="open-raio-to-ai-heading">Open Raio to AI</h3>
        </div>
        {enabled ? (
          <span className="open-raio-to-ai__status-chip">
            <CheckIcon size={12} />
            Connector on
          </span>
        ) : null}
      </header>

      <p className="settings-section__lede">
        Raio still has no AI of its own. Turn this on and whatever assistant you already use
        — Claude Desktop, Claude Code, anything that speaks MCP — can drive Raio&rsquo;s tools
        directly: split a file, run OCR, redact a term, stamp Bates numbers. Every operation
        still happens right here; nothing about your files or your prompts goes anywhere else.
      </p>

      <div className="open-raio-to-ai__toggle-row">
        <span>
          <strong id="open-raio-to-ai-toggle-label">Let your AI operate Raio</strong>
          <small id="open-raio-to-ai-toggle-hint">
            Off means the connector refuses every request, even if it&rsquo;s installed.
          </small>
        </span>
        <Switch
          checked={enabled}
          onChange={onToggle}
          aria-labelledby="open-raio-to-ai-toggle-label"
          aria-describedby="open-raio-to-ai-toggle-hint"
        />
      </div>

      <p className="open-raio-to-ai__trust-chip">
        <ShieldCheckIcon size={13} checked={false} />
        On-device only — nothing leaves this computer
      </p>

      {enabled ? (
        <div className="open-raio-to-ai__connect">
          <h4>Connect your AI</h4>
          <p className="open-raio-to-ai__connect-lede">
            Paste the block for whichever assistant you use, then restart it once.
          </p>

          <CopyBlock
            label="Claude Desktop"
            caption={
              <>
                Add to <code>claude_desktop_config.json</code>, then restart Claude Desktop.
              </>
            }
            code={desktopSnippet}
            copyKey="desktop"
            copiedKey={copiedKey}
            onCopy={copy}
            pathResolved={pathResolved}
          />

          <CopyBlock
            label="Claude Code"
            caption="Run once in a terminal. Claude Code remembers it from then on."
            code={codeCommand}
            copyKey="code"
            copiedKey={copiedKey}
            onCopy={copy}
            pathResolved={pathResolved}
          />

          {!pathResolved ? (
            <p className="open-raio-to-ai__resolving" id="open-raio-to-ai-resolving" role="status">
              Still resolving Raio&rsquo;s install path — reopen this panel if the blocks above
              still show <code>{PLACEHOLDER_PATH}</code>.
            </p>
          ) : null}

          <p className="open-raio-to-ai__how">
            How it works: this starts a small local connector that only talks to the AI client
            that launched it, over stdio — no network port, nothing reaches the internet. Full
            details, including what to do if a request refuses to run, live in{" "}
            <a
              className="open-raio-to-ai__doc-link"
              href={MCP_DOCS_URL}
              target="_blank"
              rel="noreferrer"
            >
              <code>docs/MCP.md</code>
            </a>
            .
          </p>
        </div>
      ) : null}
    </section>
  );
}

interface CopyBlockProps {
  label: string;
  caption: ReactNode;
  code: string;
  copyKey: string;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => void;
  pathResolved: boolean;
}

function CopyBlock({ label, caption, code, copyKey, copiedKey, onCopy, pathResolved }: CopyBlockProps) {
  const justCopied = copiedKey === copyKey;

  return (
    <div className="open-raio-to-ai__block">
      <div className="open-raio-to-ai__block-header">
        <span className="open-raio-to-ai__block-label">{label}</span>
        <button
          type="button"
          className="open-raio-to-ai__copy-button"
          data-copied={justCopied ? "true" : undefined}
          aria-disabled={pathResolved ? undefined : "true"}
          aria-describedby={pathResolved ? undefined : "open-raio-to-ai-resolving"}
          onClick={() => {
            if (pathResolved) {
              onCopy(copyKey, code);
            }
          }}
          title={pathResolved ? `Copy the ${label} snippet` : "Waiting for Raio to resolve its install path"}
        >
          {justCopied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {justCopied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="open-raio-to-ai__code">
        <code>{code}</code>
      </pre>
      <p className="open-raio-to-ai__block-caption">{caption}</p>
    </div>
  );
}

function buildClaudeDesktopSnippet(command: string): string {
  return JSON.stringify({ mcpServers: { raiopdf: { command } } }, null, 2);
}

function buildClaudeCodeCommand(command: string): string {
  // Quote the path so a binary path with spaces (or a custom RAIOPDF_MCP_BIN)
  // reaches `claude mcp add` as a single command argument.
  return `claude mcp add raiopdf -- "${command}"`;
}
