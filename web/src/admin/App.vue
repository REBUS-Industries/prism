<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { adminApi, healthApi, type PrismTool } from '../shared/api';
import ThemeToggle from '../shared/ThemeToggle.vue';
import Icon from '../shared/Icon.vue';
import { adminWs } from '../shared/ws';
import { useToolAccess } from './useToolAccess';

const router = useRouter();
const route = useRoute();
const username = ref<string | null>(null);
const serverVersion = ref<string | null>(null);
const ready = ref(false);
const submittingPortal = ref(false);
const { refreshToolAccess, canUseTool } = useToolAccess();

function showTool(tool: PrismTool): boolean {
  return canUseTool(tool);
}

onMounted(async () => {
  healthApi.get().then((h) => { serverVersion.value = h.version; }).catch(() => null);

  const search = new URLSearchParams(window.location.search);
  const portalCode = search.get('code');
  if (search.get('portal_callback') && portalCode) {
    submittingPortal.value = true;
    try {
      const redirectUri = `${window.location.origin}/admin/?portal_callback=1`;
      const result = await adminApi.loginGoogle(portalCode, redirectUri);
      username.value = result.username;
      window.history.replaceState({}, '', '/admin/#/');
      adminWs.connect();
      ready.value = true;
      await router.replace({ name: 'dashboard' });
      return;
    } catch (err) {
      const message = (err as { message?: string }).message ?? 'Google sign-in failed';
      await router.replace({ name: 'login', query: { error: message } });
    } finally {
      submittingPortal.value = false;
      ready.value = true;
    }
    return;
  }

  try {
    const me = await adminApi.me();
    username.value = me.principal?.username ?? null;
    adminWs.connect();
    await refreshToolAccess();
  } catch {
    // Not authenticated — bounce to login, unless we're already there.
    if (route.name !== 'login') router.replace({ name: 'login' });
  } finally {
    ready.value = true;
  }
});

async function logout() {
  await adminApi.logout().catch(() => null);
  username.value = null;
  adminWs.disconnect();
  router.replace({ name: 'login' });
}
</script>

<template>
  <div v-if="ready" :class="['layout', { 'layout--bare': route.name === 'login' }]">
    <div v-if="submittingPortal" class="portal-overlay">Signing in with Google…</div>
    <aside v-if="route.name !== 'login'">
      <div class="brand">
        <img src="/prism-logo.png" alt="PRISM" class="brand-logo" />
        <span class="brand-mark">PR<span class="brand-accent">ISM</span></span>
      </div>
      <nav>
        <RouterLink :to="{ name: 'dashboard'    }"><Icon name="dashboard" :size="18" />Dashboard</RouterLink>
        <RouterLink :to="{ name: 'workstations' }"><Icon name="desktop_windows" :size="18" />Workstations</RouterLink>
        <RouterLink :to="{ name: 'pipeline'     }" v-if="showTool('convert')"><Icon name="account_tree" :size="18" />Pipeline</RouterLink>
        <RouterLink :to="{ name: 'visualiser'   }" v-if="showTool('visualiser')"><Icon name="view_in_ar" :size="18" />Visualiser</RouterLink>
        <RouterLink v-if="showTool('visualiser')" :to="{ name: 'project-attachments' }" class="nav-sub"><Icon name="attachment" :size="16" />Project attachments</RouterLink>
        <RouterLink :to="{ name: 'materials'    }" v-if="showTool('materials')"><Icon name="palette" :size="18" />Materials</RouterLink>
        <RouterLink v-if="showTool('materials')" :to="{ name: 'textures'     }" class="nav-sub"><Icon name="texture" :size="16" />Textures</RouterLink>
        <RouterLink :to="{ name: 'fixtures'     }" v-if="showTool('fixtures')"><Icon name="travel_explore" :size="18" />GDTF Share Library</RouterLink>
        <RouterLink :to="{ name: 'prism-library' }" v-if="showTool('fixtures')"><Icon name="lightbulb" :size="18" />PRISM Library</RouterLink>
        <RouterLink v-if="showTool('fixtures')" :to="{ name: 'fixture-import' }" class="nav-sub"><Icon name="upload_file" :size="16" />Import GDTF</RouterLink>
        <RouterLink v-if="showTool('fixtures')" :to="{ name: 'fixture-materials' }" class="nav-sub"><Icon name="palette" :size="16" />Fixture materials</RouterLink>
        <RouterLink :to="{ name: 'models'       }" v-if="showTool('models')"><Icon name="deployed_code" :size="18" />Model Library</RouterLink>
        <RouterLink v-if="showTool('models')" :to="{ name: 'model-import' }" class="nav-sub"><Icon name="upload_file" :size="16" />Import model</RouterLink>
        <RouterLink :to="{ name: 'permissions'  }"><Icon name="shield" :size="18" />Permissions</RouterLink>
        <RouterLink :to="{ name: 'tool-access'  }" class="nav-sub"><Icon name="build" :size="16" />Tool access</RouterLink>
        <RouterLink :to="{ name: 'settings'     }"><Icon name="settings" :size="18" />Settings</RouterLink>
        <RouterLink :to="{ name: 'analytics'    }"><Icon name="analytics" :size="18" />Analytics</RouterLink>
        <RouterLink :to="{ name: 'logs'         }"><Icon name="receipt_long" :size="18" />Logs</RouterLink>
        <a href="/docs/" target="_blank" rel="noopener" class="external"><Icon name="menu_book" :size="16" />API docs<Icon name="open_in_new" :size="14" class="external-tail" /></a>
      </nav>
      <div class="user-box">
        <div class="muted" style="font-size: 11px;">Signed in as</div>
        <RouterLink :to="{ name: 'profile' }" class="profile-link">
          {{ username ?? '—' }}
        </RouterLink>
        <div class="user-actions">
          <button class="flex-1" @click="logout">Log out</button>
          <ThemeToggle />
        </div>
      </div>
      <div v-if="serverVersion" class="server-version muted">PRISM server v{{ serverVersion }}</div>
    </aside>
    <main class="app-shell-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}
.layout--bare { grid-template-columns: 1fr; }
.layout--bare main { padding: 0; overflow: visible; background: hsl(var(--background)); }

aside {
  background: hsl(var(--sidebar-background));
  border-right: 1px solid hsl(var(--sidebar-border));
  padding: 0 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  z-index: 40;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 68px;
  min-height: 68px;
  padding: 0 4px;
  font-weight: 700;
  font-size: 1rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: hsl(var(--sidebar-foreground));
}
.brand-logo { width: 32px; height: 32px; object-fit: contain; }

nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
nav a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: calc(var(--radius) - 2px);
  color: hsl(var(--sidebar-foreground));
  text-decoration: none;
  font-weight: 500;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  transition: background-color 120ms ease, color 120ms ease;
}
nav a .external-tail { margin-left: auto; opacity: 0.7; }
nav a:hover {
  background: hsl(var(--sidebar-accent));
  color: hsl(var(--sidebar-accent-foreground));
}
nav a.router-link-active {
  background: hsl(var(--sidebar-accent));
  color: hsl(var(--sidebar-primary));
  font-weight: 600;
}
nav a.nav-sub {
  padding-left: 24px;
  font-size: 0.75rem;
  font-weight: 400;
  letter-spacing: 0.02em;
}
nav a.external {
  margin-top: 8px;
  border-top: 1px solid hsl(var(--sidebar-border));
  padding-top: 14px;
  font-size: 0.75rem;
}
nav a.external:hover { color: hsl(var(--sidebar-foreground)); }

.user-box {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid hsl(var(--sidebar-border));
}
.server-version { font-size: 0.6875rem; text-align: center; }
.user-actions { display: flex; align-items: center; gap: 6px; }
.profile-link {
  color: hsl(var(--sidebar-foreground));
  text-decoration: none;
  font-weight: 600;
  padding: 4px 0;
}
.profile-link:hover { color: hsl(var(--sidebar-primary)); }

main { padding: 16px 24px; }

.portal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: hsl(var(--background) / 0.72);
  font-weight: 600;
  letter-spacing: 0.03em;
}
</style>
