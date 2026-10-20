import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export class ServiceManager {
  static getServiceFilePath() {
    const userSystemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    return path.join(userSystemdDir, 'antigravity-light.service');
  }

  static generateUnitContent() {
    const nodeExec = process.execPath;
    const entryScript = path.join(projectRoot, 'src', 'index.js');
    const userPath = process.env.PATH || `${os.homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin`;

    return `[Unit]
Description=Antigravity Light Daemon & OpenAI Proxy
Documentation=https://github.com/
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectRoot}
ExecStart=${nodeExec} ${entryScript} start
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PATH=${userPath}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  }

  static install() {
    if (process.platform !== 'linux') {
      console.warn(`Systemd service installation is supported on Linux. On ${process.platform}, use 'npm run start:detached'.`);
      return false;
    }

    try {
      const userSystemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      if (!fs.existsSync(userSystemdDir)) {
        fs.mkdirSync(userSystemdDir, { recursive: true });
      }

      const servicePath = this.getServiceFilePath();
      fs.writeFileSync(servicePath, this.generateUnitContent(), 'utf8');
      console.log(`✓ Created service unit: ${servicePath}`);

      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync('systemctl --user enable antigravity-light.service', { stdio: 'inherit' });

      // Enable lingering so service persists across reboots/logouts without interactive session
      try {
        const username = os.userInfo().username;
        execSync(`loginctl enable-linger ${username}`, { stdio: 'ignore' });
        console.log(`✓ Enabled systemd user lingering for '${username}' (runs on boot always).`);
      } catch {}

      console.log('✓ Service successfully installed and enabled to run at boot/login.');
      return true;
    } catch (err) {
      console.error('Failed to install service:', err.message);
      return false;
    }
  }

  static start() {
    try {
      execSync('systemctl --user start antigravity-light.service', { stdio: 'inherit' });
      console.log('✓ Service started.');
      this.status();
    } catch (err) {
      console.error('Failed to start service:', err.message);
    }
  }

  static stop() {
    try {
      execSync('systemctl --user stop antigravity-light.service', { stdio: 'inherit' });
      console.log('✓ Service stopped.');
    } catch (err) {
      console.error('Failed to stop service:', err.message);
    }
  }

  static restart() {
    try {
      execSync('systemctl --user restart antigravity-light.service', { stdio: 'inherit' });
      console.log('✓ Service restarted.');
      this.status();
    } catch (err) {
      console.error('Failed to restart service:', err.message);
    }
  }

  static status() {
    try {
      execSync('systemctl --user status antigravity-light.service --no-pager', { stdio: 'inherit' });
    } catch (err) {
      // systemctl returns non-zero if inactive/failed, output is already inherited
    }
  }

  static logs(lines = 30) {
    try {
      execSync(`journalctl --user -u antigravity-light.service -n ${lines} --no-pager`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Failed to read logs:', err.message);
    }
  }

  static uninstall() {
    try {
      try {
        execSync('systemctl --user stop antigravity-light.service', { stdio: 'ignore' });
      } catch {}
      try {
        execSync('systemctl --user disable antigravity-light.service', { stdio: 'ignore' });
      } catch {}

      const servicePath = this.getServiceFilePath();
      if (fs.existsSync(servicePath)) {
        fs.unlinkSync(servicePath);
      }
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      console.log('✓ Service uninstalled.');
    } catch (err) {
      console.error('Failed to uninstall service:', err.message);
    }
  }
}
