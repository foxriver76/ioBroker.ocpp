const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');

// Define directories to create
const dirs = [
    path.join(docsDir, 'de', 'media'),
    path.join(docsDir, 'en', 'media')
];

// Ensure directories exist and contain .gitkeep
for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const gitkeepPath = path.join(dir, '.gitkeep');
    if (!fs.existsSync(gitkeepPath)) {
        fs.writeFileSync(gitkeepPath, '');
    }
}

// Copy and transform README.md (EN) to docs/en/README.md
const enReadmeSrc = path.join(rootDir, 'README.md');
const enReadmeDst = path.join(docsDir, 'en', 'README.md');
if (fs.existsSync(enReadmeSrc)) {
    let content = fs.readFileSync(enReadmeSrc, 'utf8');
    // Replace link to German version docs/de/README.md with relative link to ../de/README.md
    content = content.replace(/\]\(docs\/de\/README\.md\)/g, '](../de/README.md)');
    // Replace link to older changelog CHANGELOG_OLD.md with relative link to root
    content = content.replace(/\]\(CHANGELOG_OLD\.md\)/g, '](../../CHANGELOG_OLD.md)');
    // Replace link to LICENSE file with relative link to root
    content = content.replace(/\]\(LICENSE\)/g, '](../../LICENSE)');
    // Replace relative logo path admin/ocpp.png with relative link to root admin/
    content = content.replace(/\]\(admin\/ocpp\.png\)/g, '](../../admin/ocpp.png)');
    fs.writeFileSync(enReadmeDst, content, 'utf8');
    console.log('Synchronized README.md -> docs/en/README.md successfully.');
} else {
    console.error('Source README.md not found.');
}

// Normalize relative links in docs/de/README.md
const deReadmePath = path.join(docsDir, 'de', 'README.md');
if (fs.existsSync(deReadmePath)) {
    let content = fs.readFileSync(deReadmePath, 'utf8');
    content = content.replace(/\]\(README\.md\)/g, '](../../README.md)');
    content = content.replace(/\]\(CHANGELOG_OLD\.md\)/g, '](../../CHANGELOG_OLD.md)');
    content = content.replace(/\]\(LICENSE\)/g, '](../../LICENSE)');
    content = content.replace(/\]\(admin\/ocpp\.png\)/g, '](../../admin/ocpp.png)');
    fs.writeFileSync(deReadmePath, content, 'utf8');
    console.log('Verified docs/de/README.md links successfully.');
} else {
    console.error('docs/de/README.md not found.');
}

console.log('Documentation sync complete.');
