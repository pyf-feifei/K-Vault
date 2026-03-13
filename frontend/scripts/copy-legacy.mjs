import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(process.cwd(), '..');
const frontendDir = path.resolve(process.cwd());
const distDir = path.resolve(process.cwd(), 'dist');
const mode = process.argv[2] === 'app-root' ? 'app-root' : 'landing-root';

const legacyFiles = [
  'index.html',
  'login.html',
  'admin.html',
  'admin-imgtc.html',
  'admin-waterfall.html',
  'gallery.html',
  'preview.html',
  'block-img.html',
  'whitelist-on.html',
  'theme.css',
  'theme.js',
  'mobile-refactor.css',
  'admin-imgtc.css',
  'favicon.ico',
  'favicon.svg',
  'logo.png',
  'bg.svg',
  'music.svg',
];

const legacyDirs = ['_nuxt'];

function ensureDir(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

function copyFile(from, to) {
  if (!fs.existsSync(from)) return;
  ensureDir(to);
  fs.copyFileSync(from, to);
}

function copyEntry(relativePath, targetBase = '') {
  const from = path.resolve(rootDir, relativePath);
  if (!fs.existsSync(from)) return;
  const to = path.resolve(distDir, targetBase, relativePath);
  ensureDir(to);

  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.cpSync(from, to, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(from, to);
}

fs.mkdirSync(distDir, { recursive: true });

// Keep legacy pages at root for backward compatibility. In app-root mode we keep the
// Vite-generated SPA entry as /index.html; in landing-root mode we replace it below.
for (const file of legacyFiles) {
  if (file !== 'index.html') {
    copyEntry(file);
  }
  copyEntry(file, 'legacy');
}
for (const dir of legacyDirs) {
  copyEntry(dir);
  copyEntry(dir, 'legacy');
}

if (mode === 'landing-root') {
  // Product landing page for "/".
  copyFile(
    path.resolve(frontendDir, 'landing', 'index.html'),
    path.resolve(distDir, 'index.html')
  );
  copyFile(
    path.resolve(frontendDir, 'landing', '_redirects'),
    path.resolve(distDir, '_redirects')
  );
}

console.log(`[frontend] ${mode} build prepared with legacy compatibility assets`);
