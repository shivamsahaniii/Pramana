import { useEffect, useState } from 'react';
import { detectOS, shortcutLabels } from '../shared/platform';
import type { OS } from '../shared/platform';
import { UBUNTU_COMMANDS } from './ubuntuCommands';
import { MAX_RECORDING_MINUTES } from '../shared/limits';


function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the command can still be selected by hand
    }
  };
  return (
    <div className="help-command">
      <code>{text}</code>
      <button className="btn-ghost" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

const OS_NAMES: Record<OS, string> = { mac: 'Mac', windows: 'Windows', linux: 'Linux', chromeos: 'ChromeOS', other: 'your computer' };

export function Help() {
  const os = detectOS();
  const keys = shortcutLabels(os);

  // ?help=ubuntu (from the recorder window) jumps straight to the Ubuntu section
  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get('help');
    if (section) document.getElementById(`help-${section}`)?.scrollIntoView();
  }, []);

  return (
    <div className="dashboard-container help-page">
      <header className="dashboard-header">
        <h1>Pramana Help</h1>
        <a className="btn-ghost" href="?">
          ← Library
        </a>
      </header>

      <section className="help-section" id="help-capture">
        <h2>Screenshots</h2>
        <p>
          <strong>Visible Tab</strong> captures what you see now. <strong>Select Area</strong> lets you drag around one part.{' '}
          <strong>Full Page</strong> scrolls through the page for you and joins every screen into one tall image, top to bottom.
        </p>
        <p>
          During a full-page capture the Pramana icon counts the screens (for example 3/8). Chrome allows two screenshots a second, so a
          long page takes a few seconds; press <kbd>Esc</kbd> to cancel. Menus and banners that stay in place while you scroll are
          captured once instead of on every screen. A page that keeps loading more as you scroll is captured up to its length when you
          started, and an extremely long page stops where the image reaches the largest size Chrome can hold.
        </p>
        <p>
          In the editor, <strong>Text size</strong> appears with the Text tool: use <strong>A−</strong> and <strong>A+</strong> or the
          slider. It also resizes text you already placed: pick it with the Select tool first.
        </p>
      </section>

      <section className="help-section" id="help-folder">
        <h2>Where your captures are saved</h2>
        <p>
          Everything goes to one folder in your Google Drive, <strong>Pramana</strong> unless you choose another: click the 📁 button at
          the top of the Library, or <strong>Change</strong> at the bottom of the popup. You can create as many folders as you like (one
          per project or case) and switch between them; the Library shows the folder you are saving to.
        </p>
        <p>
          Google only lets Pramana see folders it created itself, which is what keeps the rest of your Drive private from it, so your
          existing folders can't be picked. To keep captures inside one of them, create a folder here, then move it there in Google
          Drive. Pramana keeps saving to it wherever you move it, and whatever you rename it to.
        </p>
      </section>

      <section className="help-section" id="help-recording">
        <h2>Recording your screen</h2>
        <p>
          <strong>Record Tab</strong> starts straight away with no pop-ups. <strong>Record Screen</strong> needs your permission each time:
          Chrome shows <em>Choose what to share</em> with <strong>Entire screen</strong> already selected, so you click{' '}
          <strong>Share</strong>. Chrome requires this for every extension, so websites and extensions can't watch your screen without
          you knowing.
        </p>
        <table className="help-table">
          <thead>
            <tr>
              <th />
              <th>Windows</th>
              <th>Mac</th>
              <th>Ubuntu</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Chrome's picker</td>
              <td>Click Share</td>
              <td>Click Share</td>
              <td>Click Share</td>
            </tr>
            <tr>
              <td>System permission</td>
              <td>None</td>
              <td>Once: allow Chrome to record the screen</td>
              <td>Ubuntu's Share Screen window, each time (can be removed, below)</td>
            </tr>
            <tr>
              <td>Computer sound</td>
              <td>Tick “Share system audio” in the picker</td>
              <td>Only from a tab: use Record Tab</td>
              <td>Only from a tab: use Record Tab</td>
            </tr>
          </tbody>
        </table>
        <p>
          While recording, the controls are on the Pramana icon in Chrome's toolbar ({keys.pause} pauses or resumes, {keys.stop}{' '}
          stops), so nothing of Pramana appears in your video. Chrome's own “sharing your screen” bar does: click <strong>Hide</strong>{' '}
          on it after you start. A recording can be up to {MAX_RECORDING_MINUTES} minutes long; time spent paused doesn't count.
        </p>
        <h3>Floating timer and controls</h3>
        <p>
          With <strong>Floating timer and controls</strong> switched on in the popup, a small window with the timer, Pause and Stop stays
          on top of your other windows while you record. It is a separate window, so it is <strong>not in the video</strong> when you
          record a tab or a single window. Drag it anywhere; closing it doesn't stop the recording.
        </p>
        <p>
          When you record your <strong>entire screen</strong>, everything on the screen is recorded, and only the operating system can
          hide a window from that, not Chrome. So there the floating window is in the video too: drag it to a corner, or close it and
          use the icon or the shortcuts. A small minimized “Pramana” window in your taskbar keeps the floating controls alive: leave it
          there.
        </p>
        <h3>Long recordings</h3>
        <p>
          Nothing is converted after you stop: the video is recorded as MP4 directly, so it is ready to review at once. Saving to Drive
          takes as long as your upload speed needs. A long recording of a busy screen can reach a few hundred megabytes; it uploads in
          pieces with a progress bar, and carries on by itself if your connection drops for a moment. Keep the Library tab open until it
          says saved.
        </p>
        {os !== 'other' && <p className="help-note">You are using {OS_NAMES[os]}.</p>}
      </section>

      <section className="help-section" id="help-mac">
        <h2>Mac: allow screen recording</h2>
        <p>
          If recording your screen fails with “did not allow screen sharing”, open <strong>System Settings → Privacy &amp; Security → Screen
          Recording</strong> (called “Screen &amp; System Audio Recording” on newer macOS), turn on <strong>Google Chrome</strong>, then quit
          and reopen Chrome. You only do this once.
        </p>
      </section>

      <section className="help-section" id="help-ubuntu">
        <h2>Ubuntu: remove the screen-sharing pop-ups</h2>
        <p>
          Optional, for your own computer. Open a terminal (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>), paste a command and press Enter.
          Each step works on its own; do one or both. For Google Chrome installed from google.com on Ubuntu 22.04 or later.
        </p>

        <h3>1. Remove Ubuntu's “Share Screen” window</h3>
        <p>Switches your login to Xorg, which doesn't ask before apps see the screen. Asks for your password.</p>
        <Command text={UBUNTU_COMMANDS.xorg} />
        <p>
          Restart your computer. To check, this should print <code>x11</code>:
        </p>
        <Command text={UBUNTU_COMMANDS.xorgCheck} />
        <p className="help-note">
          Without a command: at the login screen click your name, then the ⚙️ at the bottom right, and choose “Ubuntu on Xorg”.
        </p>

        <h3>2. Remove Chrome's “Choose what to share” window</h3>
        <p className="help-warning">
          ⚠️ After this, <strong>any website</strong> that asks to share your screen gets your whole screen without asking, including
          video calls. Only do this on a computer you use for recording.
        </p>
        <Command text={UBUNTU_COMMANDS.chrome} />
        <p>Then close Chrome completely (this closes every Chrome window) and open it again from the dock or app menu:</p>
        <Command text={UBUNTU_COMMANDS.chromeRestart} />
        <p className="help-note">
          To check, open <code>chrome://version</code>: “Command Line” should include <code>--auto-select-desktop-capture-source</code>.
          Chrome started any other way (from a terminal, or by a link from another app) shows the picker as usual.
        </p>

        <h3>Undo</h3>
        <p>Back to Ubuntu's normal login (then restart):</p>
        <Command text={UBUNTU_COMMANDS.undoXorg} />
        <p>Chrome's picker back:</p>
        <Command text={UBUNTU_COMMANDS.undoChrome} />
      </section>
    </div>
  );
}
