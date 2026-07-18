import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, PlugIcon, ShieldCheckIcon } from "../icons";
import { useSectionFocus } from "../hooks/useSectionFocus";
import { Switch } from "./Switch";
import "./SettingsSectionCard.css";
import "./OpenRaioToAiSection.css";

const PLACEHOLDER_PATH = "<RAIOPDF_MCP_PATH>";

// The repo is public, so this resolves even pre-release. Revisit if/when
// docs/MCP.md gets a hosted page of its own on raio.macrify.me.
const MCP_DOCS_URL = "https://github.com/Macrify-LLC/raiopdf/blob/main/docs/MCP.md";

const COPIED_LABEL_MS = 1600;
const COPY_FAILED_LABEL_MS = 2400;

const WAITING_FOR_PATH_TITLE = "Waiting for Raio to resolve its install path";

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
  /** Persistence/status message for the access gate. */
  status?: string | null | undefined;
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
  status,
  focused = false,
  onFocusHandled,
}: OpenRaioToAiSectionProps) {
  const { sectionRef, showFocusRing } = useSectionFocus(focused, onFocusHandled);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFailedKey, setCopyFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedKey) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopiedKey(null), COPIED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copiedKey]);

  useEffect(() => {
    if (!copyFailedKey) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopyFailedKey(null), COPY_FAILED_LABEL_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copyFailedKey]);

  const copy = useCallback((key: string, text: string) => {
    setCopyFailedKey(null);

    try {
      if (!navigator.clipboard?.writeText) {
        setCopiedKey(null);
        setCopyFailedKey(key);
        return;
      }

      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedKey(key);
        })
        .catch(() => {
          setCopiedKey(null);
          setCopyFailedKey(key);
        });
    } catch {
      setCopiedKey(null);
      setCopyFailedKey(key);
    }
  }, []);

  const pathResolved = Boolean(mcpPath);
  const resolvedOrPlaceholder = mcpPath ?? PLACEHOLDER_PATH;
  const desktopSnippet = buildClaudeDesktopSnippet(resolvedOrPlaceholder);
  const codeCommand = buildClaudeCodeCommand(resolvedOrPlaceholder);
  const setupPrompt = buildSetupPrompt(resolvedOrPlaceholder);
  const promptCopyFailed = copyFailedKey === "prompt";

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
      {status ? (
        <p className="open-raio-to-ai__status-line" role="status">
          {status}
        </p>
      ) : null}

      <p className="open-raio-to-ai__trust-chip">
        <ShieldCheckIcon size={13} checked={false} />
        On-device only — nothing leaves this computer
      </p>

      {enabled ? (
        <div className="open-raio-to-ai__connect">
          <h4>Connect your AI</h4>
          <p className="open-raio-to-ai__connect-lede">
            Easiest option: copy the setup prompt below and hand it to your AI assistant
            &mdash; it&rsquo;ll take it from there. Want to wire it up yourself instead? The
            manual config is tucked below.
          </p>

          <div className="open-raio-to-ai__guided">
            <div className="open-raio-to-ai__guided-text">
              <p className="open-raio-to-ai__guided-title">Let your AI set it up</p>
              <p className="open-raio-to-ai__guided-body">
                Copy this and paste it into Claude Code, Claude Desktop, or any assistant that
                can run commands. It reads the instructions, finds the right config file for
                your computer, and gets Raio&rsquo;s connector registered.
              </p>
            </div>
            <CopyButton
              copyKey="prompt"
              text={setupPrompt}
              label="Copy setup prompt"
              title="Copy the guided setup prompt"
              copiedKey={copiedKey}
              copyFailedKey={copyFailedKey}
              onCopy={copy}
              pathResolved={pathResolved}
              className="open-raio-to-ai__guided-button"
              iconSize={14}
            />
            {promptCopyFailed ? (
              <>
                <ClipboardBlockedNote />
                <pre className="open-raio-to-ai__code">
                  <code>{setupPrompt}</code>
                </pre>
              </>
            ) : null}
          </div>

          <details className="open-raio-to-ai__manual">
            <summary className="open-raio-to-ai__manual-summary">
              <ChevronDownIcon size={13} className="open-raio-to-ai__manual-chevron" />
              Rather set it up by hand?
            </summary>
            <div className="open-raio-to-ai__manual-body">
              <CopyBlock
                label="Claude Desktop"
                caption={
                  <>
                    Add to <code>claude_desktop_config.json</code>, then restart Claude
                    Desktop.
                  </>
                }
                code={desktopSnippet}
                copyKey="desktop"
                copiedKey={copiedKey}
                copyFailedKey={copyFailedKey}
                onCopy={copy}
                pathResolved={pathResolved}
              />

              <CopyBlock
                label="Claude Code"
                caption="Run once in a terminal. Claude Code remembers it from then on."
                code={codeCommand}
                copyKey="code"
                copiedKey={copiedKey}
                copyFailedKey={copyFailedKey}
                onCopy={copy}
                pathResolved={pathResolved}
              />
            </div>
          </details>

          {!pathResolved ? (
            <p className="open-raio-to-ai__resolving" id="open-raio-to-ai-resolving" role="status">
              Still resolving Raio&rsquo;s install path — the copy buttons switch on once it
              lands. Reopen this panel if it stays stuck.
            </p>
          ) : null}

          <p className="open-raio-to-ai__how">
            How it works: this starts a small local connector that only talks to the AI app
            that launched it — no network connection, nothing reaches the internet. Full
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

function ClipboardBlockedNote() {
  return (
    <p className="open-raio-to-ai__block-status" role="status">
      Clipboard access was blocked. Select the text below and copy it manually.
    </p>
  );
}

interface CopyButtonProps {
  /** Distinguishes this button in the shared copy-state machine. */
  copyKey: string;
  /** The text placed on the clipboard. */
  text: string;
  /** Resting button label, e.g. "Copy" or "Copy setup prompt". */
  label: string;
  /** Tooltip shown while the button is active (path resolved). */
  title: string;
  copiedKey: string | null;
  copyFailedKey: string | null;
  onCopy: (key: string, text: string) => void;
  pathResolved: boolean;
  /** Skin class — the subtle chip or the primary guided treatment. */
  className: string;
  iconSize?: number;
}

/**
 * The single copy button used across this section. Owns the shared copy-state
 * contract (icon swap, "Copied"/"Could not copy" text, `data-copy-state`, and
 * the path-not-resolved disabled state) so it lives in exactly one place;
 * callers pass a skin `className` and the text to copy.
 */
function CopyButton({
  copyKey,
  text,
  label,
  title,
  copiedKey,
  copyFailedKey,
  onCopy,
  pathResolved,
  className,
  iconSize = 13,
}: CopyButtonProps) {
  const justCopied = copiedKey === copyKey;
  const copyFailed = copyFailedKey === copyKey;

  return (
    <button
      type="button"
      className={className}
      data-copy-state={justCopied ? "copied" : copyFailed ? "failed" : undefined}
      aria-disabled={pathResolved ? undefined : "true"}
      aria-describedby={pathResolved ? undefined : "open-raio-to-ai-resolving"}
      onClick={() => {
        if (pathResolved) {
          onCopy(copyKey, text);
        }
      }}
      title={pathResolved ? title : WAITING_FOR_PATH_TITLE}
    >
      {justCopied ? <CheckIcon size={iconSize} /> : <CopyIcon size={iconSize} />}
      {justCopied ? "Copied" : copyFailed ? "Could not copy" : label}
    </button>
  );
}

interface CopyBlockProps {
  label: string;
  caption: ReactNode;
  code: string;
  copyKey: string;
  copiedKey: string | null;
  copyFailedKey: string | null;
  onCopy: (key: string, text: string) => void;
  pathResolved: boolean;
}

function CopyBlock({
  label,
  caption,
  code,
  copyKey,
  copiedKey,
  copyFailedKey,
  onCopy,
  pathResolved,
}: CopyBlockProps) {
  const copyFailed = copyFailedKey === copyKey;

  return (
    <div className="open-raio-to-ai__block">
      <div className="open-raio-to-ai__block-header">
        <span className="open-raio-to-ai__block-label">{label}</span>
        <CopyButton
          copyKey={copyKey}
          text={code}
          label="Copy"
          title={`Copy the ${label} snippet`}
          copiedKey={copiedKey}
          copyFailedKey={copyFailedKey}
          onCopy={onCopy}
          pathResolved={pathResolved}
          className="open-raio-to-ai__copy-button"
          iconSize={13}
        />
      </div>
      {copyFailed ? <ClipboardBlockedNote /> : null}
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

/**
 * The plain-language prompt behind the "Copy setup prompt" button. Composes
 * the two manual snippets above so path-escaping stays correct on Windows,
 * and hands the whole job to whatever AI assistant the user pastes it into
 * -- including finding the right config file and restarting the assistant,
 * which is the part a newcomer is least equipped to do by hand. Exported so
 * it can be unit-tested independent of the component.
 */
export function buildSetupPrompt(command: string): string {
  const desktopSnippet = buildClaudeDesktopSnippet(command);
  const codeCommand = buildClaudeCodeCommand(command);

  return [
    "I want to connect RaioPDF's local connector to my AI assistant so it can operate RaioPDF for me — things like splitting PDFs, running OCR, redacting text, and stamping Bates numbers. RaioPDF runs entirely on my own computer and this connector makes no network calls; every operation stays on my machine.",
    "",
    "Please set it up for me and confirm it works.",
    "",
    "RaioPDF's connector is a local program at this path:",
    command,
    "",
    "There are two ways to register it, depending on which assistant I'm using:",
    "",
    "1. Claude Code (command line): run this once, then restart Claude Code:",
    codeCommand,
    "",
    "2. Claude Desktop: add this to the claude_desktop_config.json file, then fully quit and reopen Claude Desktop:",
    desktopSnippet,
    "",
    "If you're able to run commands or edit files yourself, please just do it for me: work out which assistant this is, find the right config file for my operating system, make the change, and restart it if you can. If you can't, walk me through the exact steps one at a time.",
    "",
    "When you're finished, check the connection by listing RaioPDF's tools. If a tool comes back refused, the safety switch is still off — tell me to open RaioPDF, go to Settings → \"Open Raio to AI\", and turn on \"Let your AI operate Raio\".",
    "",
    `More detail and troubleshooting: ${MCP_DOCS_URL}`,
  ].join("\n");
}
