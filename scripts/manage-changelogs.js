const fs = require('node:fs');
const path = require('node:path');

const readmePath = path.join(__dirname, '../README.md');
const readmeDePath = path.join(__dirname, '../README_de.md');
const changelogOldPath = path.join(__dirname, '../CHANGELOG_OLD.md');

function migrateToChangelogOld(moveBlocks) {
    if (!fs.existsSync(changelogOldPath)) {
        console.error('CHANGELOG_OLD.md not found!');
        return;
    }

    let oldContent = fs.readFileSync(changelogOldPath, 'utf8');
    const originalLineEndings = oldContent.includes('\r\n') ? '\r\n' : '\n';
    oldContent = oldContent.replace(/\r\n/g, '\n');

    const insertAfterMarker = '# Older changes';
    const insertIndex = oldContent.indexOf(insertAfterMarker);
    if (insertIndex === -1) {
        console.error(`Marker "${insertAfterMarker}" not found in CHANGELOG_OLD.md`);
        return;
    }

    const insertPosition = insertIndex + insertAfterMarker.length;
    let newEntriesText = '';

    for (const block of moveBlocks) {
        const version = block.version;
        const escapedVersion = version.replace(/\./g, '\\.');
        const versionRegex = new RegExp(`^##\\s+v?${escapedVersion}\\b`, 'm');
        if (versionRegex.test(oldContent)) {
            console.log(`Version ${version} is already present in CHANGELOG_OLD.md. Skipping duplication.`);
            continue;
        }

        const headerLine = block.lines[0].replace(/^###\s+/, '## ');
        const restLines = block.lines.slice(1).join('\n').trim();
        newEntriesText += `\n\n${headerLine}\n${restLines}`;
    }

    if (newEntriesText) {
        const updatedOldContent =
            oldContent.substring(0, insertPosition) +
            '\n\n' +
            newEntriesText.trim() +
            '\n' +
            oldContent.substring(insertPosition);
        fs.writeFileSync(changelogOldPath, updatedOldContent.replace(/\n/g, originalLineEndings), 'utf8');
        console.log('Migrated older version(s) to CHANGELOG_OLD.md.');
    }
}

function processReadme(filePath, startRegex, endRegex, isEnglish) {
    if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}`);
        return;
    }
    let content = fs.readFileSync(filePath, 'utf8');

    const originalLineEndings = content.includes('\r\n') ? '\r\n' : '\n';
    content = content.replace(/\r\n/g, '\n');

    const startMatch = content.match(startRegex);
    if (!startMatch) {
        console.error(`Start marker not found in ${path.basename(filePath)}`);
        return;
    }
    const startIndex = startMatch.index;
    const searchFrom = startIndex + startMatch[0].length;

    const endMatch = content.substring(searchFrom).match(endRegex);
    if (!endMatch) {
        console.error(`End marker not found in ${path.basename(filePath)}`);
        return;
    }
    const endIndex = searchFrom + endMatch.index;

    const changelogSection = content.substring(searchFrom, endIndex);
    const lines = changelogSection.split('\n');
    const versionHeaderRegex = /^###\s+(v?\d+\.\d+\.\d+(?:-\w+\.\d+)?|\*\*WORK IN PROGRESS\*\*)/i;

    const blocks = [];
    let currentBlock = null;

    for (const line of lines) {
        const match = line.match(versionHeaderRegex);
        if (match) {
            if (currentBlock) {
                blocks.push(currentBlock);
            }
            currentBlock = {
                header: line,
                version: match[1],
                isWip: match[1].includes('WORK IN PROGRESS'),
                lines: [line]
            };
        } else if (currentBlock) {
            currentBlock.lines.push(line);
        } else if (line.trim()) {
            blocks.push({
                header: '',
                version: '',
                isWip: false,
                lines: [line]
            });
        }
    }
    if (currentBlock) {
        blocks.push(currentBlock);
    }

    const versionBlocks = blocks.filter(b => b.version && !b.isWip);

    if (versionBlocks.length <= 5) {
        console.log(`${path.basename(filePath)} has ${versionBlocks.length} versions. No rotation needed.`);
        return;
    }

    console.log(
        `Rotating changelog in ${path.basename(filePath)}: total ${versionBlocks.length} versions found (limit: 5).`
    );

    const keepBlocks = [];
    const moveBlocks = [];

    let keptVersionsCount = 0;
    for (const block of blocks) {
        if (!block.version || block.isWip) {
            keepBlocks.push(block);
        } else if (keptVersionsCount < 5) {
            keepBlocks.push(block);
            keptVersionsCount++;
        } else {
            moveBlocks.push(block);
        }
    }

    const keptText =
        '\n\n' +
        keepBlocks
            .map(b => b.lines.join('\n').trim())
            .filter(Boolean)
            .join('\n\n') +
        '\n\n';
    const newContent = content.substring(0, searchFrom) + keptText + content.substring(endIndex);

    fs.writeFileSync(filePath, newContent.replace(/\n/g, originalLineEndings), 'utf8');

    if (isEnglish && moveBlocks.length > 0) {
        migrateToChangelogOld(moveBlocks);
    }
}

processReadme(readmePath, /^##\s+Changelog\b/im, /^(?:\[Older changelog|##\s+License)/im, true);
processReadme(readmeDePath, /^##\s+Änderungsprotokoll\s+\(Changelog\)/im, /^(?:\[Ältere Einträge|##\s+Lizenz)/im, false);

