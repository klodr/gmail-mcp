#!/usr/bin/env node

// Basic debugging script
console.log('====== Starting Setup Script ======');

try {
  // ES module imports
  console.log('Importing modules...');
  import('fs').then(fs => {
    console.log('Successfully imported fs module');
    
    import('path').then(path => {
      console.log('Successfully imported path module');
      
      import('os').then(os => {
        console.log('Successfully imported os module');
        
        import('child_process').then(({ execSync }) => {
          console.log('Successfully imported child_process module');
          
          import('url').then(({ fileURLToPath }) => {
            console.log('Successfully imported url module');
            
            // Get directory path
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            console.log(`Current directory: ${__dirname}`);
            
            // Check Node.js version
            const nodeVersion = process.versions.node.split('.');
            console.log(`Node.js version: ${process.versions.node}`);
            
            // Project path
            const basePath = path.resolve(__dirname);
            console.log(`Project path: ${basePath}`);
            
            // Create configuration
            console.log('Starting to create MCP configuration...');
            const serverScriptPath = path.join(basePath, 'dist', 'index.js');
            console.log(`Server script path: ${serverScriptPath}`);
            
            // Create configuration directory
            const configDir = path.join(os.homedir(), '.gmail-mcp');
            console.log(`Configuration directory: ${configDir}`);
            
            if (!fs.existsSync(configDir)) {
              console.log('Creating configuration directory...');
              fs.mkdirSync(configDir, { recursive: true });
              console.log('Configuration directory created successfully');
            } else {
              console.log('Configuration directory already exists');
            }
            
            // Create MCP configuration
            const config = {
              "mcpServers": {
                "gmail": {
                  "command": "node",
                  "args": [serverScriptPath]
                }
              }
            };
            
            // Save configuration
            const configPath = path.join(basePath, 'mcp-config.json');
            console.log(`Saving configuration to: ${configPath}`);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log('Configuration saved');
            
            // Get Claude Desktop configuration path
            let claudeConfigPath;
            if (process.platform === 'win32') {
              claudeConfigPath = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
            } else if (process.platform === 'darwin') {
              claudeConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
            } else {
              claudeConfigPath = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
            }
            
            console.log(`Claude Desktop configuration path: ${claudeConfigPath}`);
            
            // Output instructions
            console.log('\n===== Setup Complete =====');
            console.log(`MCP configuration written to: ${configPath}`);
            console.log('\nMCP configuration content:');
            console.log(JSON.stringify(config, null, 2));
            console.log(`\nPlease merge this configuration into the Claude Desktop configuration file: ${claudeConfigPath}`);
            console.log('\nBefore using the Gmail MCP server, you need to authenticate:');
            console.log(`node ${serverScriptPath} auth`);
            
            console.log('\nSetup complete! You can now use the Gmail MCP server with compatible clients.');
          }).catch(err => {
            console.error('Error importing url module:', err);
          });
        }).catch(err => {
          console.error('Error importing child_process module:', err);
        });
      }).catch(err => {
        console.error('Error importing os module:', err);
      });
    }).catch(err => {
      console.error('Error importing path module:', err);
    });
  }).catch(err => {
    console.error('Error importing fs module:', err);
  });
} catch (error) {
  console.error('Error executing script:', error);
}
