# Gmail Filter Management Examples

This document provides practical examples of how to use the new Gmail filter functionality in the MCP server.

## Quick Start

After setting up authentication and adding the required scope, you can start creating filters to automate your email management.

## Common Use Cases

### 1. Newsletter Management
Automatically organize newsletters:

```
Template: fromSender
Parameters: senderEmail, labelIds, archive
```

### 2. Work Email Organization
Create filters for work emails from managers and team notifications.

### 3. Automated Filing
Set up filters to automatically file financial emails and support tickets.

### 4. Large Attachment Management
Handle emails with large attachments by applying special labels.

## Best Practices

1. Start Simple: Begin with basic filters using templates
2. Test Criteria: Use search_emails to test filter criteria first
3. Use Labels Strategically: Create logical label hierarchy
4. Review Regularly: Clean up unused filters periodically
5. Combine with Batch Operations: Apply filters retroactively

## Limitations

- Maximum of 1,000 filters per Gmail account
- Only one user-defined label can be added per filter
- Forwarding requires verified destination addresses
- Some system labels cannot be removed 