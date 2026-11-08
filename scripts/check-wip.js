const fs = require('node:fs');
const path = require('node:path');

function checkWip(file) {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');

    const wipRegex = /^### \*\*WORK IN PROGRESS\*\*/m;
    const match = content.match(wipRegex);

    if (!match || match.index === undefined) {
        console.error(`Error: '### **WORK IN PROGRESS**' section is missing in ${file}`);
        process.exit(1);
    }

    const start = match.index + match[0].length;
    const nextSectionIndex = content.indexOf('### ', start);
    const end = nextSectionIndex !== -1 ? nextSectionIndex : undefined;
    const wipContent = content.substring(start, end).trim();

    if (!wipContent?.includes('*')) {
        console.error(`Error: '### **WORK IN PROGRESS**' in ${file} is empty.`);
        console.error('Please add changelog entries before releasing.');
        process.exit(1);
    }
}

checkWip('README.md');
checkWip('docs/de/README.md');

console.log('Changelog (WORK IN PROGRESS) verified successfully.');
