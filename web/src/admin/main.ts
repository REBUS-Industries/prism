import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import Dashboard from './pages/Dashboard.vue';
import Workstations from './pages/Workstations.vue';
import Settings from './pages/Settings.vue';
import ApiKeys from './pages/ApiKeys.vue';
import Users from './pages/Users.vue';
import Analytics from './pages/Analytics.vue';
import Pipeline from './pages/Pipeline.vue';
import Webhooks from './pages/Webhooks.vue';
import Profile from './pages/Profile.vue';
import Logs from './pages/Logs.vue';
import Login from './pages/Login.vue';
import Visualiser from './pages/Visualiser.vue';
import VisualiserViewer from './pages/VisualiserViewer.vue';
import ProjectAttachments from './pages/ProjectAttachments.vue';
import Materials from './pages/Materials.vue';
import MaterialEditor from './pages/MaterialEditor.vue';
import Textures from './pages/Textures.vue';
import Fixtures from './pages/Fixtures.vue';
import PrismLibrary from './pages/PrismLibrary.vue';
import FixtureEditor from './pages/FixtureEditor.vue';
import FixtureGdtfDebug from './pages/FixtureGdtfDebug.vue';
import FixtureDmxCharts from './pages/FixtureDmxCharts.vue';
import FixtureImport from './pages/FixtureImport.vue';
import FixtureMaterials from './pages/FixtureMaterials.vue';
import Models from './pages/Models.vue';
import ModelCreate from './pages/ModelCreate.vue';
import ModelImport from './pages/ModelImport.vue';
import ModelEditor from './pages/ModelEditor.vue';
import Files from './pages/Files.vue';
import FileDetail from './pages/FileDetail.vue';
import FileUpload from './pages/FileUpload.vue';
import Permissions from './pages/Permissions.vue';
import ToolAccess from './pages/ToolAccess.vue';
import type { PrismTool } from '../shared/api';
import { useToolAccess } from './useToolAccess';

import '../shared/designSystem.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/',                       component: Dashboard,        name: 'dashboard' },
    { path: '/workstations',           component: Workstations,     name: 'workstations' },
    { path: '/pipeline',               component: Pipeline,         name: 'pipeline', meta: { tool: 'convert' as PrismTool } },
    { path: '/visualiser',             component: Visualiser,       name: 'visualiser', meta: { tool: 'visualiser' as PrismTool } },
    { path: '/visualiser/attachments', component: ProjectAttachments, name: 'project-attachments', meta: { tool: 'visualiser' as PrismTool } },
    { path: '/visualiser/:runId',      component: VisualiserViewer, name: 'visualiser-viewer', props: true, meta: { tool: 'visualiser' as PrismTool } },
    { path: '/materials',              component: Materials,        name: 'materials', meta: { tool: 'materials' as PrismTool } },
    { path: '/materials/:id',          component: MaterialEditor,   name: 'material-editor', props: true, meta: { tool: 'materials' as PrismTool } },
    { path: '/textures',               component: Textures,         name: 'textures', meta: { tool: 'materials' as PrismTool } },
    // Two fixture libraries: `fixtures` is the GDTF Share catalog browser
    // (download source); `prism-library` is the editable PRISM-owned set the
    // ORBIT connector + ORBIT consume.
    { path: '/fixtures',               component: Fixtures,       name: 'fixtures', meta: { tool: 'fixtures' as PrismTool } },
    { path: '/fixtures/library',       component: PrismLibrary,   name: 'prism-library', meta: { tool: 'fixtures' as PrismTool } },
    { path: '/fixtures/import',        component: FixtureImport,  name: 'fixture-import', meta: { tool: 'fixtures' as PrismTool } },
    { path: '/fixtures/materials',     component: FixtureMaterials, name: 'fixture-materials', meta: { tool: 'fixtures' as PrismTool } },
    { path: '/fixtures/:id/debug',     component: FixtureGdtfDebug, name: 'fixture-debug', props: true, meta: { tool: 'fixtures' as PrismTool } },
    { path: '/fixtures/:id/dmx',       component: FixtureDmxCharts, name: 'fixture-dmx-charts', props: true, meta: { tool: 'fixtures' as PrismTool } },
    { path: '/fixtures/:id',           component: FixtureEditor,    name: 'fixture-editor', props: true, meta: { tool: 'fixtures' as PrismTool } },
    // Model library (generic 3D assets) — prism-models-service.
    // Static segments (`create`, `import`, `library`) must be registered before `:id`.
    { path: '/models',                 component: Models,           name: 'models', meta: { tool: 'models' as PrismTool } },
    { path: '/models/library',         component: Models,           name: 'model-library', meta: { tool: 'models' as PrismTool } },
    { path: '/models/create',          component: ModelCreate,      name: 'model-create', meta: { tool: 'models' as PrismTool } },
    { path: '/models/import',          component: ModelImport,      name: 'model-import', meta: { tool: 'models' as PrismTool } },
    { path: '/models/:id',             component: ModelEditor,      name: 'model-editor', props: true, meta: { tool: 'models' as PrismTool } },
    // File library — native CAD/DCC source archives (versioned by filename).
    { path: '/files',                  component: Files,            name: 'files', meta: { tool: 'files' as PrismTool } },
    { path: '/files/upload',           component: FileUpload,       name: 'file-upload', meta: { tool: 'files' as PrismTool } },
    { path: '/files/:id',              component: FileDetail,       name: 'file-detail', props: true, meta: { tool: 'files' as PrismTool } },
    { path: '/permissions',            component: Permissions,      name: 'permissions' },
    { path: '/permissions/tools',      component: ToolAccess,       name: 'tool-access', meta: { requiresAdmin: true } },
    { path: '/settings',               component: Settings,         name: 'settings' },
    { path: '/keys',                   component: ApiKeys,          name: 'keys' },
    { path: '/webhooks',               component: Webhooks,         name: 'webhooks' },
    { path: '/users',                  component: Users,            name: 'users' },
    { path: '/analytics',              component: Analytics,        name: 'analytics' },
    { path: '/profile',                component: Profile,          name: 'profile' },
    { path: '/logs',                   component: Logs,             name: 'logs' },
    { path: '/login',                  component: Login,            name: 'login' },
  ],
});

const { refreshToolAccess, canUseTool, loaded } = useToolAccess();

router.beforeEach(async (to) => {
  if (to.name === 'login') return true;
  const tool = to.meta.tool as PrismTool | undefined;
  if (!tool) return true;
  if (!loaded.value) await refreshToolAccess();
  if (canUseTool(tool)) return true;
  return { name: 'dashboard', query: { denied: tool } };
});

createApp(App).use(router).use(createPinia()).mount('#app');
