#!/usr/bin/env node

// 基础调试脚本
console.log('====== 开始执行设置脚本 ======');

try {
  // ES 模块导入
  console.log('正在导入模块...');
  import('fs').then(fs => {
    console.log('成功导入 fs 模块');
    
    import('path').then(path => {
      console.log('成功导入 path 模块');
      
      import('os').then(os => {
        console.log('成功导入 os 模块');
        
        import('child_process').then(({ execSync }) => {
          console.log('成功导入 child_process 模块');
          
          import('url').then(({ fileURLToPath }) => {
            console.log('成功导入 url 模块');
            
            // 获取目录路径
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            console.log(`当前目录: ${__dirname}`);
            
            // 检查 Node.js 版本
            const nodeVersion = process.versions.node.split('.');
            console.log(`Node.js 版本: ${process.versions.node}`);
            
            // 项目路径
            const basePath = path.resolve(__dirname);
            console.log(`项目路径: ${basePath}`);
            
            // 创建配置
            console.log('开始创建 MCP 配置...');
            const serverScriptPath = path.join(basePath, 'dist', 'index.js');
            console.log(`服务器脚本路径: ${serverScriptPath}`);
            
            // 创建配置目录
            const configDir = path.join(os.homedir(), '.gmail-mcp');
            console.log(`配置目录: ${configDir}`);
            
            if (!fs.existsSync(configDir)) {
              console.log('创建配置目录...');
              fs.mkdirSync(configDir, { recursive: true });
              console.log('配置目录创建成功');
            } else {
              console.log('配置目录已存在');
            }
            
            // 创建 MCP 配置
            const config = {
              "mcpServers": {
                "gmail": {
                  "command": "node",
                  "args": [serverScriptPath]
                }
              }
            };
            
            // 保存配置
            const configPath = path.join(basePath, 'mcp-config.json');
            console.log(`正在保存配置到: ${configPath}`);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log('配置已保存');
            
            // 获取 Claude Desktop 配置路径
            let claudeConfigPath;
            if (process.platform === 'win32') {
              claudeConfigPath = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
            } else if (process.platform === 'darwin') {
              claudeConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
            } else {
              claudeConfigPath = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
            }
            
            console.log(`Claude Desktop 配置路径: ${claudeConfigPath}`);
            
            // 输出说明
            console.log('\n===== 设置完成 =====');
            console.log(`MCP 配置已写入: ${configPath}`);
            console.log('\nMCP 配置内容:');
            console.log(JSON.stringify(config, null, 2));
            console.log(`\n请将此配置合并到 Claude Desktop 配置文件: ${claudeConfigPath}`);
            console.log('\n在使用 Gmail MCP 服务器之前，您需要进行身份验证:');
            console.log(`node ${serverScriptPath} auth`);
            
            console.log('\n设置完成! 您现在可以将 Gmail MCP 服务器与兼容的客户端一起使用。');
          }).catch(err => {
            console.error('导入 url 模块时出错:', err);
          });
        }).catch(err => {
          console.error('导入 child_process 模块时出错:', err);
        });
      }).catch(err => {
        console.error('导入 os 模块时出错:', err);
      });
    }).catch(err => {
      console.error('导入 path 模块时出错:', err);
    });
  }).catch(err => {
    console.error('导入 fs 模块时出错:', err);
  });
} catch (error) {
  console.error('执行脚本时出错:', error);
}