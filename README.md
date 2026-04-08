<h5>BACKGROUND</h5>
In the video game, Zoo Tycoon (2001), image assets (including animals, foliage, UI icons and so on) are stored as ZT files. These are binary files lacking an extension (often simply named "n" - meaning north, referring to in-game orientation - or something like that). Their colours are defined in associated .pal files; these are palette files that store up the 256 colors (so every individual image in Zoo Tycoon is limited to 256 colors).

These files are cumbersome and difficult to edit effectively. The purpose of this tool is to convert ZT files (and their .pal files) into PNGs for easier editing in other graphic editing software programmes (e.g. GIMP). Crucially, it also allows PNG files to be converted into a ZT file with an associated .pal.

<h5>REQUIREMENTS</h5>
<ul>
<li><strong>Node.js</strong> — Install a current LTS release from <a href="https://nodejs.org/">nodejs.org</a>. The scripts use only built-in Node modules (<code>fs</code>, <code>path</code>, <code>zlib</code>); no <code>npm install</code> is required.</li>
<li><strong>PATH</strong> — The <code>node</code> command must work in a terminal (macOS/Linux) or Command Prompt (Windows). If the GUI launcher says Node is missing, fix your Node install or PATH, or run the scripts manually: <code>node src/pngToZt1Assets.js</code> or <code>node src/zt1GraphicToPng.js</code> from the project root folder.</li>
</ul>

<h5>RUNNING FROM THE GUI</h5>
<ul>
<li><strong>macOS:</strong> Double-click <code>Run-ZT-Converter.command</code>. Terminal opens; pick <em>PNG → ZT1</em> or <em>ZT1 → PNG</em>. If Finder warns that the file cannot be verified, use right-click → Open the first time.</li>
<li><strong>Windows:</strong> Double-click <code>Run-ZT-Converter.bat</code> and enter <code>1</code> or <code>2</code> at the prompt.</li>
</ul>