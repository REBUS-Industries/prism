// Phase 0 stub. Phase 4 wires the convert flow + layer tree + progress.
import { createApp, h } from 'vue';

const Root = {
  setup() {
    return () => h('div', { style: { padding: '2rem', fontFamily: 'sans-serif' } }, [
      h('h1', 'PRISM convert'),
      h('p', 'Phase 0 scaffold — convert SPA will be filled in by Phase 4.'),
    ]);
  },
};

createApp(Root).mount('#app');
