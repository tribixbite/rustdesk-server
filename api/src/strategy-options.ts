/**
 * Client options offered in the console's strategy editor. Values are strings,
 * as the client stores them; option names and values come from the client
 * (libs/hbb_common config.rs `keys`, flutter server_model.dart / settings page).
 * A strategy may also set any other option by name.
 */

export type OptionKind =
  | { type: "bool" }
  | { type: "enum"; values: Array<{ value: string; label: string }> }
  | { type: "number"; min?: number; max?: number }
  | { type: "text"; placeholder?: string };

export interface StrategyOption {
  key: string;
  label: string;
  group: "Permissions" | "Security" | "Network" | "Session";
  kind: OptionKind;
}

const bool: OptionKind = { type: "bool" };

export const STRATEGY_OPTIONS: readonly StrategyOption[] = [
  {
    key: "access-mode",
    label: "Permission set for incoming sessions",
    group: "Permissions",
    kind: {
      type: "enum",
      values: [
        { value: "full", label: "Full access" },
        { value: "view", label: "Screen share (view only)" },
        { value: "custom", label: "Custom (the switches below)" },
      ],
    },
  },
  { key: "enable-keyboard", label: "Allow keyboard and mouse", group: "Permissions", kind: bool },
  { key: "enable-clipboard", label: "Allow clipboard", group: "Permissions", kind: bool },
  { key: "enable-file-transfer", label: "Allow file transfer", group: "Permissions", kind: bool },
  { key: "enable-file-copy-paste", label: "Allow copying files via the clipboard", group: "Permissions", kind: bool },
  { key: "enable-audio", label: "Allow audio", group: "Permissions", kind: bool },
  { key: "enable-camera", label: "Allow camera", group: "Permissions", kind: bool },
  { key: "enable-terminal", label: "Allow terminal", group: "Permissions", kind: bool },
  { key: "enable-tunnel", label: "Allow TCP tunnelling", group: "Permissions", kind: bool },
  { key: "enable-remote-restart", label: "Allow remote restart", group: "Permissions", kind: bool },
  { key: "enable-record-session", label: "Allow recording the session", group: "Permissions", kind: bool },
  { key: "enable-block-input", label: "Allow blocking user input", group: "Permissions", kind: bool },
  { key: "enable-privacy-mode", label: "Allow privacy mode", group: "Permissions", kind: bool },
  { key: "enable-remote-printer", label: "Allow remote printing", group: "Permissions", kind: bool },
  { key: "allow-remote-config-modification", label: "Allow remote configuration changes", group: "Permissions", kind: bool },
  {
    key: "approve-mode",
    label: "How incoming sessions are accepted",
    group: "Security",
    kind: {
      type: "enum",
      values: [
        { value: "", label: "Password or click" },
        { value: "password", label: "Password only" },
        { value: "click", label: "Click to accept only" },
      ],
    },
  },
  {
    key: "verification-method",
    label: "Password type",
    group: "Security",
    kind: {
      type: "enum",
      values: [
        { value: "use-temporary-password", label: "One-time password" },
        { value: "use-permanent-password", label: "Permanent password" },
        { value: "use-both-passwords", label: "Either" },
      ],
    },
  },
  {
    key: "temporary-password-length",
    label: "One-time password length",
    group: "Security",
    kind: { type: "enum", values: ["6", "8", "10"].map((v) => ({ value: v, label: v })) },
  },
  { key: "allow-numeric-one-time-password", label: "Numeric one-time password", group: "Security", kind: bool },
  { key: "allow-hide-cm", label: "Hide the connection window (password approval only)", group: "Security", kind: bool },
  { key: "allow-only-conn-window-open", label: "Only accept while the RustDesk window is open", group: "Security", kind: bool },
  { key: "whitelist", label: "IP whitelist (comma-separated; empty = any)", group: "Security", kind: { type: "text", placeholder: "192.168.1.0/24,203.0.113.7" } },
  { key: "id-whitelist", label: "ID whitelist (comma-separated; empty = any)", group: "Security", kind: { type: "text" } },
  { key: "allow-scope-violation-close", label: "Close sessions that exceed their scope", group: "Security", kind: bool },
  { key: "allow-scope-violation-alarm", label: "Raise an alarm on scope violations", group: "Security", kind: bool },
  { key: "enable-lan-discovery", label: "LAN discovery", group: "Network", kind: bool },
  { key: "direct-server", label: "Accept direct IP connections", group: "Network", kind: bool },
  { key: "direct-access-port", label: "Direct IP access port", group: "Network", kind: { type: "number", min: 1, max: 65535 } },
  { key: "allow-auto-disconnect", label: "Disconnect idle sessions", group: "Session", kind: bool },
  { key: "auto-disconnect-timeout", label: "Idle timeout (minutes)", group: "Session", kind: { type: "number", min: 1 } },
  { key: "allow-remove-wallpaper", label: "Remove wallpaper during sessions", group: "Session", kind: bool },
  { key: "allow-auto-record-incoming", label: "Record incoming sessions automatically", group: "Session", kind: bool },
  { key: "allow-auto-record-outgoing", label: "Record outgoing sessions automatically", group: "Session", kind: bool },
  { key: "enable-abr", label: "Adaptive bitrate", group: "Session", kind: bool },
  { key: "enable-hwcodec", label: "Hardware codec", group: "Session", kind: bool },
];
