import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchRoot } from './Workbench';
import '../ui/theme.css';
import '../ui/character-tokens.css';
import '../ui/character-theme.css';
import './workbench.css';

if (!import.meta.env.DEV) throw new Error('UI workbench is development-only');
const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(<StrictMode><WorkbenchRoot /></StrictMode>);
