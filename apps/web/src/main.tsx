import '@fontsource-variable/nunito';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { config } from '@/config';
import { registerServiceWorker } from '@/lib/pwa';

async function boot() {
  if (config.mock) {
    const { startMocks } = await import('@/mocks/browser');
    await startMocks();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
registerServiceWorker();
