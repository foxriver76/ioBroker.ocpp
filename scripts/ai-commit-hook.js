const { execSync } = require('node:child_process');
const fs = require('node:fs');

if (typeof process.loadEnvFile === 'function') {
    try {
        process.loadEnvFile();
    } catch {
        // Ignore if .env does not exist
    }
}

const commitMsgFile = process.argv[2];
const commitSource = process.argv[3];

if (!commitMsgFile) {
    console.error('[AI-Commit-Hook] Error: No path to commit message file provided.');
    process.exit(1);
}

function getGitDiff() {
    try {
        return execSync('git diff --cached').toString();
    } catch {
        console.error('[AI-Commit-Hook] Error retrieving git diff.');
        process.exit(1);
    }
}

async function generateCommitMessage(diff) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('\n[AI-Commit-Hook] Warning: GEMINI_API_KEY environment variable is not set.');
        return null;
    }

    const prompt = `You are a professional Git expert. Generate a detailed and structured commit message based on the following git diff of staged changes for the ioBroker.ocpp adapter.
Use the "Conventional Commits" format.

Format:
<type>(<scope>): <short summary in English>

- <detailed change 1 in English>
- <detailed change 2 in English (WHAT was changed and why)>

Rules:
1. Type must be one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore.
2. Scope corresponds to the affected area (e.g., ocpp, server, states, admin, docs, dev).
3. The summary in the header must be short and concise in English and start with a lowercase letter.
4. The bullet points in the body must describe in detail in English WHAT was changed and WHY.
5. Each line in the body must be at most 72 characters long.
6. Reply ONLY with the commit message. No markdown code blocks (\`\`\`), no introduction, no explanation.

Here is the Git Diff:
${diff}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;
}

function formatCommitMessage(msg) {
    if (!msg) return msg;
    const lines = msg.split('\n');
    if (lines.length === 0) return msg;

    const header = lines[0];
    const headerMatch = header.match(/^([a-z]+)(?:\(([^)]+)\))?:\s*(.*)$/);
    if (headerMatch) {
        const type = headerMatch[1];
        const scope = headerMatch[2] ? `(${headerMatch[2]})` : '';
        let subject = headerMatch[3].trim();
        if (subject.length > 0) {
            subject = subject[0].toLowerCase() + subject.slice(1);
        }
        lines[0] = `${type}${scope}: ${subject}`;
    }

    const wrapText = (text, maxLength) => {
        const words = text.split(' ');
        const resultLines = [];
        let currentLine = '';

        for (const word of words) {
            if ((currentLine + (currentLine ? ' ' : '') + word).length <= maxLength) {
                currentLine += (currentLine ? ' ' : '') + word;
            } else {
                if (currentLine) {
                    resultLines.push(currentLine);
                }
                currentLine = word;
            }
        }
        if (currentLine) {
            resultLines.push(currentLine);
        }
        return resultLines;
    };

    const formattedLines = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            formattedLines.push('');
            continue;
        }
        if (line.trim().startsWith('- ')) {
            const content = line.substring(line.indexOf('- ') + 2).trim();
            const wrapped = wrapText(content, 70);
            wrapped.forEach((wLine, index) => {
                formattedLines.push(index === 0 ? `- ${wLine}` : `  ${wLine}`);
            });
        } else {
            const wrapped = wrapText(line.trim(), 72);
            formattedLines.push(...wrapped);
        }
    }

    return formattedLines.join('\n');
}

async function main() {
    if (commitSource) {
        return;
    }

    let existingContent = '';
    if (fs.existsSync(commitMsgFile)) {
        existingContent = fs
            .readFileSync(commitMsgFile, 'utf-8')
            .split('\n')
            .filter(line => !line.trim().startsWith('#'))
            .join('\n')
            .trim();
    }

    if (existingContent.length > 0) {
        return;
    }

    const diff = getGitDiff();
    if (!diff.trim()) {
        return;
    }

    console.log('[AI-Commit-Hook] Generating commit message via Gemini...');
    try {
        const commitMsg = await generateCommitMessage(diff);
        if (commitMsg) {
            const formattedMsg = formatCommitMessage(commitMsg);
            fs.writeFileSync(commitMsgFile, formattedMsg, 'utf-8');
            console.log('[AI-Commit-Hook] Commit message inserted successfully.');
        }
    } catch (err) {
        console.error('\n[AI-Commit-Hook] Generation failed:', err.message);
    }
}

main();
