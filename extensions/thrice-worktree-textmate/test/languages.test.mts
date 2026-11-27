import test from 'node:test';
import { readFileSync } from 'node:fs';
import { same } from '../../_thrice-clone-test/helper.mts';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const embedded: Record<string, string> = {
	'worktree-typescript': 'source.ts',
	'worktree-typescriptreact': 'source.tsx',
	'worktree-javascript': 'source.js',
	'worktree-javascriptreact': 'source.js.jsx',
	'worktree-python': 'source.python',
	'worktree-go': 'source.go',
	'worktree-rust': 'source.rust',
	'worktree-java': 'source.java',
	'worktree-c': 'source.c',
	'worktree-cpp': 'source.cpp',
	'worktree-php': 'source.php',
	'worktree-ruby': 'source.ruby',
	'worktree-html': 'text.html.basic',
	'worktree-css': 'source.css',
	'worktree-json': 'source.json',
	'worktree-yaml': 'source.yaml',
	'worktree-sql': 'source.sql',
	'worktree-swift': 'source.swift',
	'worktree-shellscript': 'source.shell',
	'worktree-protobuf': 'source.proto',
};

test('28 worktree languages keep the confirmed filename patterns', () => {
	same(manifest.contributes.languages.length, 28);
	same(manifest.contributes.languages.map((language: { id: string }) => language.id), Object.keys({
		...embedded,
		'worktree-hcl': true,
		'worktree-terraform': true,
		'worktree-terraform-vars': true,
		'worktree-terraform-stack': true,
		'worktree-terraform-deploy': true,
		'worktree-terraform-test': true,
		'worktree-terraform-mock': true,
		'worktree-terraform-search': true,
	}));
	const cpp = manifest.contributes.languages.find((language: { id: string }) => language.id === 'worktree-cpp');
	same(cpp.filenamePatterns, ['**/.cursor/worktrees/**/*.cpp', '**/.cursor/worktrees/**/*.h', '**/.cursor/worktrees/**/*.hpp']);
});

test('grammars embed a stock scope or an original keyword rule', () => {
	for (const grammar of manifest.contributes.grammars) {
		const body = JSON.parse(readFileSync(new URL(grammar.path, root), 'utf8'));
		same(body.scopeName, 'source.' + grammar.language);
		if (grammar.language in embedded) {
			same(body.patterns, [{ include: embedded[grammar.language] }]);
		} else {
			same(body.patterns[0].include, undefined);
			same(typeof body.patterns[0].match, 'string');
		}
	}
});
