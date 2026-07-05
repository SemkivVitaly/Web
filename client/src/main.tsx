/**
 * @fileoverview Точка входа Vite/React: монтирование `App` в `#root`, глобальные стили.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DialogHost } from './ui/dialogs';
import './App.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <DialogHost />
  </StrictMode>
);
