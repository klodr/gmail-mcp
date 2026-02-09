/**
 * Tests for email threading header fixes (issue #66)
 *
 * Verifies:
 * 1. createEmailMessage uses separate `references` field when provided
 * 2. createEmailMessage falls back to `inReplyTo` for References when no `references` field
 * 3. No References/In-Reply-To headers on new emails
 * 4. Source verification: createEmailWithNodemailer uses references field
 * 5. Source verification: handleEmailAction auto-resolves threading headers
 * 6. Source verification: read_email returns Message-ID
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmailMessage } from './utl.js';

// Resolve src directory (tests run from dist/, sources are in src/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', 'src');

// Helper: extract a header value from a raw MIME message string
function getHeader(raw: string, headerName: string): string | null {
    const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'mi');
    const match = raw.match(regex);
    return match ? match[1].trim() : null;
}

async function runTests() {
    // --- Test 1: References uses separate references field ---
    {
        const args = {
            to: ['test@example.com'],
            subject: 'Re: Thread test',
            body: 'Reply body',
            inReplyTo: '<msg3@example.com>',
            references: '<msg1@example.com> <msg2@example.com> <msg3@example.com>',
        };
        const raw = createEmailMessage(args);

        const referencesHeader = getHeader(raw, 'References');
        assert.equal(
            referencesHeader,
            '<msg1@example.com> <msg2@example.com> <msg3@example.com>',
            'References header should use the dedicated references field (full chain)'
        );

        const inReplyToHeader = getHeader(raw, 'In-Reply-To');
        assert.equal(
            inReplyToHeader,
            '<msg3@example.com>',
            'In-Reply-To should be the last message ID'
        );

        console.log('PASS: Test 1 - References uses separate references field');
    }

    // --- Test 2: References falls back to inReplyTo when references is absent ---
    {
        const args = {
            to: ['test@example.com'],
            subject: 'Re: Fallback test',
            body: 'Reply body',
            inReplyTo: '<single@example.com>',
            // no references field
        };
        const raw = createEmailMessage(args);

        const referencesHeader = getHeader(raw, 'References');
        assert.equal(
            referencesHeader,
            '<single@example.com>',
            'References header should fall back to inReplyTo when references is absent'
        );

        console.log('PASS: Test 2 - References falls back to inReplyTo');
    }

    // --- Test 3: No References/In-Reply-To when neither is set ---
    {
        const args = {
            to: ['test@example.com'],
            subject: 'New email',
            body: 'Fresh email body',
            // no inReplyTo, no references
        };
        const raw = createEmailMessage(args);

        const referencesHeader = getHeader(raw, 'References');
        const inReplyToHeader = getHeader(raw, 'In-Reply-To');
        assert.equal(referencesHeader, null, 'No References header for new emails');
        assert.equal(inReplyToHeader, null, 'No In-Reply-To header for new emails');

        console.log('PASS: Test 3 - No threading headers on new emails');
    }

    // --- Test 4: Source verification - createEmailWithNodemailer uses references field ---
    {
        const source = fs.readFileSync(path.join(srcDir, 'utl.ts'), 'utf-8');

        assert.ok(
            source.includes('references: validatedArgs.references || validatedArgs.inReplyTo'),
            'createEmailWithNodemailer should use references field with inReplyTo fallback'
        );

        console.log('PASS: Test 4 - Source verification: createEmailWithNodemailer references pattern');
    }

    // --- Test 5: Source verification - index.ts auto-resolves threading headers ---
    {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');

        assert.ok(
            source.includes("validatedArgs.threadId && !validatedArgs.inReplyTo"),
            'handleEmailAction should check for threadId without inReplyTo'
        );
        assert.ok(
            source.includes("gmail.users.threads.get"),
            'handleEmailAction should fetch thread metadata'
        );
        assert.ok(
            source.includes("validatedArgs.inReplyTo = lastMessageId"),
            'handleEmailAction should set inReplyTo from last message'
        );
        assert.ok(
            source.includes("validatedArgs.references = allMessageIds.join(' ')"),
            'handleEmailAction should set references from all message IDs'
        );

        console.log('PASS: Test 5 - Source verification: handleEmailAction auto-resolution');
    }

    // --- Test 6: Source verification - read_email returns Message-ID ---
    {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');

        assert.ok(
            source.includes("message-id") && source.includes("rfcMessageId"),
            'read_email handler should extract Message-ID header'
        );
        assert.ok(
            source.includes('Message-ID: ${rfcMessageId}'),
            'read_email output should include Message-ID'
        );

        console.log('PASS: Test 6 - Source verification: read_email returns Message-ID');
    }

    console.log('\nAll 6 tests passed.');
}

runTests().catch((err) => {
    console.error('TEST FAILED:', err.message);
    process.exit(1);
});
