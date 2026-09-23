import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { AppStore } from './store.js';
import './styles.css';

const store = new AppStore();
// Handy for poking at the engine from the browser console.
(window as unknown as { warplot: AppStore }).warplot = store;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
