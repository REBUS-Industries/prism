/**
 * Single source of truth for the admin SPA's "Open Web UI" links that
 * point at each workstation agent's locally-served tray UI.
 *
 * Background
 * ----------
 * The PRISM agent (v0.1.31+) serves its tray UI on
 * `http://<host>:7421/` by default (`webUiPort` + `webUiBindAll`). The
 * `workstations` table does not yet carry a dedicated host / IP column,
 * so the admin SPA leans on `nodeName` and the LAN's DNS to resolve it.
 *
 * On the REBUS AD-joined VLAN this works out of the box (`DC1` resolves
 * bare hostnames within `ad.rebus.industries`), but the bare `nodeName`
 * doesn't always resolve from a browser on a workstation in a different
 * subnet that doesn't have AD as its DNS suffix. To fix this, the
 * admin Settings page exposes an editable `workstation_dns_suffix`
 * setting; when set (e.g. `ad.rebus.industries`), the suffix is
 * appended to `nodeName` here.
 *
 * Keep this dead simple: string concatenation, no URL constructor,
 * no protocol negotiation -- just match the literal format the agent
 * binds to.
 */

/** Default port the agent's local web UI listens on (`webUiPort` in
 *  PRISM.Agent's `AgentConfig`). Matches every install we control;
 *  if/when the port becomes per-workstation configurable we'll need
 *  to surface it through `/api/workstations` and thread it through
 *  these helpers. */
export const AGENT_WEB_UI_PORT = 7421;

/**
 * Resolve the hostname the admin browser should use to reach the
 * agent's local web UI for a given workstation.
 *
 * @param nodeName    The `nodeName` column from the workstations table.
 *                    Trimmed defensively; never empty in practice but
 *                    guarded so the URL stays well-formed.
 * @param dnsSuffix   The `workstation_dns_suffix` admin setting. When
 *                    blank/whitespace, returns the bare `nodeName`.
 *                    When set, returns `${nodeName}.${dnsSuffix}`.
 *                    Any leading `.` on the suffix is stripped here so
 *                    callers don't have to worry about double dots.
 */
export function workstationWebUiHost(nodeName: string, dnsSuffix: string): string {
  const name = (nodeName ?? '').trim();
  const suffix = (dnsSuffix ?? '').trim().replace(/^\.+/, '');
  return suffix ? `${name}.${suffix}` : name;
}

/**
 * Build the full `http://...:7421/` URL for the agent's local web UI.
 * Mirrors `workstationWebUiHost` and tacks on the port + scheme.
 */
export function workstationWebUiUrl(nodeName: string, dnsSuffix: string): string {
  return `http://${workstationWebUiHost(nodeName, dnsSuffix)}:${AGENT_WEB_UI_PORT}/`;
}
