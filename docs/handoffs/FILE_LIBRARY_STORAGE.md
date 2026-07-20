# File Library storage — parent share + per-project folders

**Status:** Host mount + compose bind via `mount-file-library` workflow.  
**Folder picker UI / per-project path DB:** not shipped yet (next File Library PR).

---

## Model

| Layer | Value |
|-------|--------|
| UNC parent | `\\fs.ad.rebus.industries\REBUS` |
| Host mount | `/mnt/fileserver/rebus` |
| Container bind | `/mnt/fileserver/rebus` |
| Global setting `file_library_root` | `/mnt/fileserver/rebus` |
| Per Orbit project | Relative path under that root |

**Example — Live Nation U2**

Remainder (store as POSIX relative path):

```text
01 CLIENTS - EXTERNAL/LN26_LIVE NATION/U227_U2 - 2027 TOUR/05_EXTERNAL SHARE/PRISM FILES
```

Resolved write root:

```text
/mnt/fileserver/rebus/01 CLIENTS - EXTERNAL/LN26_LIVE NATION/U227_U2 - 2027 TOUR/05_EXTERNAL SHARE/PRISM FILES
```

Never paste the UNC or the long client path into the global setting.

---

## Mount on VM 212 (ops)

### DNS note (VM 212)

`fs.ad.rebus.industries` is an **AD** name. Prism-prod’s default resolver often
returns NXDOMAIN. The mount script resolves via AD DNS **`10.0.10.151` /
`10.0.10.152`**, pins `/etc/hosts`, and adds a systemd-resolved drop-in for
`~ad.rebus.industries`.

### One-shot (preferred)

```bash
# Set repo secrets once (if /etc/prism/smb-rebus.credentials is not already on the VM):
#   FILESERVER_SMB_USERNAME
#   FILESERVER_SMB_PASSWORD
#   FILESERVER_SMB_DOMAIN   (optional, e.g. AD)

gh workflow run mount-file-library --repo REBUS-Industries/prism --ref main
```

Runs on `[self-hosted, prism-deploy]`, SSHs to `prism-dev` (VM 212), then:

1. Installs `cifs-utils` if needed  
2. Writes `/etc/prism/smb-rebus.credentials` (mode 600) when secrets are present  
3. Mounts `//fs.ad.rebus.industries/REBUS` → `/mnt/fileserver/rebus`  
4. Enables systemd unit `mnt-fileserver-rebus.mount` (**mounts on boot**)  
5. Sets `FILE_LIBRARY_*` in `/opt/prism/.env`  
6. Recreates `prism-server` with the bind mount from `infra/docker-compose.dev.yml`

Script: `infra/scripts/mount-file-library-share.sh`  
Workflow: `.github/workflows/mount-file-library.yml`

### Verify

```bash
ssh prism-dev 'findmnt /mnt/fileserver/rebus; ls /mnt/fileserver/rebus | head'
ssh prism-dev 'docker exec prism-server ls /mnt/fileserver/rebus | head'
systemctl is-enabled mnt-fileserver-rebus.mount   # on VM
```

Admin → Settings → File Library → storage root: `/mnt/fileserver/rebus`  
`GET /api/files/status` → `writable: true`, `root: /mnt/fileserver/rebus`.

---

## Folder picker (UI — next)

Settings / project config needs a **folder browser** over the mounted parent:

1. `GET /api/files/browse?path=` — list **directories only** under `file_library_root`  
2. Reject `..`, absolute paths, and anything outside the resolved root  
3. UI: tree or drill-down picker → saves relative path on the Orbit project  
4. Uploads with that `projectId` write under `root + relativePath` (still versioned by filename)

Until the picker ships, operators can set relative paths manually once the API/DB map exists.

---

## Security notes

- SMB password never belongs in `/opt/prism/.env` or git — only `/etc/prism/smb-rebus.credentials` or GH secrets.  
- Bind-mount the **parent** share; Prism must still path-check every project relative path.  
- Mount with `nofail,_netdev` so a share outage does not block VM boot.
