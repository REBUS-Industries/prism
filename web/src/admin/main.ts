// Phase 0 stub. Phase 4 wires Pinia + Vue Router + page components.
import { createApp, h } from 'vue';

const Root = {
  setup() {
    return () => h('div', { style: { padding: '2rem', fontFamily: 'sans-serif' } }, [
      h('h1', 'PRISM admin'),
      h('p', 'Phase 0 scaffold — admin SPA will be filled in by Phase 4.'),
    ]);
  },
};

createApp(Root).mount('#app');
