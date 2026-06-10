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
import FixtureEditor from './pages/FixtureEditor.vue';
import FixtureImport from './pages/FixtureImport.vue';

import '../shared/designSystem.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/',                       component: Dashboard,        name: 'dashboard' },
    { path: '/workstations',           component: Workstations,     name: 'workstations' },
    { path: '/pipeline',               component: Pipeline,         name: 'pipeline' },
    { path: '/visualiser',             component: Visualiser,       name: 'visualiser' },
    { path: '/visualiser/attachments', component: ProjectAttachments, name: 'project-attachments' },
    { path: '/visualiser/:runId',      component: VisualiserViewer, name: 'visualiser-viewer', props: true },
    { path: '/materials',              component: Materials,        name: 'materials' },
    { path: '/materials/:id',          component: MaterialEditor,   name: 'material-editor', props: true },
    { path: '/textures',               component: Textures,         name: 'textures' },
    { path: '/fixtures',               component: Fixtures,       name: 'fixtures' },
    { path: '/fixtures/import',        component: FixtureImport,  name: 'fixture-import' },
    { path: '/fixtures/:id',           component: FixtureEditor,    name: 'fixture-editor', props: true },
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

createApp(App).use(router).use(createPinia()).mount('#app');
