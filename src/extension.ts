import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface CodeItem {
  label: string;
  kind: string;
  detail: string;
  documentation: string;
  sourceDescription?: string; // 新增：用于存储格式化后的来源描述
}

export function activate(context: vscode.ExtensionContext) {
  // --- 1. 动态合并所有数据源 ---

  // 获取 data 目录的绝对路径
  const dataPath = path.join(context.extensionPath, "data");
  let combinedData: CodeItem[] = [];

  try {
    // 读取目录下所有 json 文件
    const files = fs
      .readdirSync(dataPath)
      .filter((file) => file.endsWith(".json"));

    combinedData = files.flatMap((file) => {
      const filePath = path.join(dataPath, file);
      const rawData = fs.readFileSync(filePath, "utf8");
      const jsonData = JSON.parse(rawData) as CodeItem[];

      // 将文件名转换为描述文字
      // 例如: "3d-model-api.json" -> "MTR 3D Model API"
      const description = formatFileNameToDescription(file);

      return jsonData.map((item) => ({
        ...item,
        sourceDescription: description, // 将来源信息注入每个条目
      }));
    });
  } catch (err) {
    console.error("读取数据文件失败:", err);
  }

  /**
   * 辅助函数：将文件名格式化为人类可读的描述
   */
  function formatFileNameToDescription(fileName: string): string {
    return fileName
      .replace(".json", "") // 去掉后缀
      .split("-") // 按连字符分割
      .map((word) => {
        if (word.toLowerCase() === "api") return "API"; // API 保持全大写
        return word.charAt(0).toUpperCase() + word.slice(1); // 首字母大写
      })
      .join(" ") // 空格合并
      .replace(/^/, "MTR "); // 统一加上 MTR 前缀
  }

  /**
   * 第一部分：代码补全 (IntelliSense)
   */
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    "javascript",
    {
      provideCompletionItems(document, position) {
        return combinedData.map((item) => {
          const signatureLabel = item.detail.includes("(")
            ? item.detail.substring(item.detail.indexOf("("))
            : "";

          const completion = new vscode.CompletionItem({
            label: item.label,
            detail: signatureLabel,
            description: item.sourceDescription,
          });

          // 1. 设置图标并决定是否需要加括号
          let isCallable = false;
          if (item.kind === "Method") {
            completion.kind = vscode.CompletionItemKind.Method;
            isCallable = true;
          } else if (item.kind === "Class") {
            completion.kind = vscode.CompletionItemKind.Class;
            // 类通常用 new，如果需要 new 完直接加括号也可以设为 true
          } else {
            completion.kind = vscode.CompletionItemKind.Function;
            isCallable = true;
          }

          // 2. 设置插入代码的内容 (SnippetString)
          if (isCallable) {
            // ${item.label}($1) 表示插入函数名和括号，$1 是光标停下的第一个位置
            completion.insertText = new vscode.SnippetString(
              `${item.label}($1)`,
            );

            // 可选：插入后自动触发参数提示 (Parameter Hints)
            completion.command = {
              title: "triggerParameterHints",
              command: "editor.action.triggerParameterHints",
            };
          } else {
            completion.insertText = item.label;
          }

          completion.documentation = new vscode.MarkdownString(
            item.documentation,
          );

          return completion;
        });
      },
    },
  );
  /**
   * 第二部分：参数提示 (Parameter Hints)
   */
  const signatureProvider = vscode.languages.registerSignatureHelpProvider(
    "javascript",
    {
      provideSignatureHelp(document, position) {
        const linePrefix = document
          .lineAt(position)
          .text.substr(0, position.character);

        const lastOpenParen = linePrefix.lastIndexOf("(");
        if (lastOpenParen === -1) return null;

        const nameMatch = linePrefix
          .substring(0, lastOpenParen)
          .match(/(\w+)\s*$/);
        if (!nameMatch) return null;

        const methodName = nameMatch[1];
        const item = combinedData.find((d) => d.label === methodName);

        if (item && item.detail.includes("(")) {
          const signatureHelp = new vscode.SignatureHelp();
          const signatureInfo = new vscode.SignatureInformation(
            item.detail,
            item.documentation,
          );

          const paramContent = item.detail.match(/\(([^)]+)\)/);
          if (paramContent) {
            const params = paramContent[1].split(",");
            signatureInfo.parameters = params.map(
              (p) => new vscode.ParameterInformation(p.trim()),
            );
          }

          signatureHelp.signatures = [signatureInfo];
          signatureHelp.activeSignature = 0;

          const textAfterParen = linePrefix.substring(lastOpenParen + 1);
          const commaCount = (textAfterParen.match(/,/g) || []).length;
          signatureHelp.activeParameter = commaCount;

          return signatureHelp;
        }
        return null;
      },
    },
    "(",
    ",",
  );
  /**
 * 第三部分：资产路径补全 (Asset Path Intellisense)
 */
  const assetProvider = vscode.languages.registerCompletionItemProvider(
  "javascript",
  {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
      // 1. 获取当前行内容及光标前的文本
      const linePrefix = document.lineAt(position).text.substr(0, position.character);
      
      // 2. 正则表达式识别是否在字符串内 (匹配 " 或 ')
      // 这里的正则可以根据 MTR 脚本的具体语法调整，例如识别 Resources.id(" 后面
      const quoteMatch = linePrefix.match(/["']([^"']*)$/);
      if (!quoteMatch) return undefined;

      const currentInput = quoteMatch[1]; // 用户已经输入的路径部分
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspaceFolder) return undefined;

      // 3. 定义扫描的根目录 (假设资源放在工作区的根目录或特定 assets 文件夹)
      // 在 MTR 中，通常是读取当前文件夹下的 textures, models, sounds 等
      const rootPath = workspaceFolder.uri.fsPath;
      
      // 4. 递归获取所有合法资产文件
      const files = getAllFiles(rootPath, currentInput);

      return files.map(fileRelativePath => {
        const item = new vscode.CompletionItem(
          fileRelativePath, 
          vscode.CompletionItemKind.File
        );
        item.detail = "MTR Asset Resource";
        // 如果是图片，可以添加一个小图标预览（VS Code 支持部分格式）
        return item;
      });
    }
  },
  '"', "'", "/" // 触发字符
);

/**
 * 辅助函数：递归扫描目录
 * @param rootDir 根目录
 * @param currentInput 当前已输入的部分路径，用于过滤（可选优化）
 */
function getAllFiles(rootDir: string, currentInput: string): string[] {
  const results: string[] = [];
  // 定义 MTR 脚本常用的资产后缀
  const allowedExtensions = ['.png', '.obj', '.bbmodel', '.json', '.ogg', '.csv'];

  function recursiveScan(dir: string) {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat && stat.isDirectory()) {
        // 忽略 node_modules 或 .git 等无关目录
        if (file !== 'node_modules' && file !== '.git') {
          recursiveScan(fullPath);
        }
      } else {
        const ext = path.extname(file).toLowerCase();
        if (allowedExtensions.includes(ext)) {
          // 转换为相对路径，并统一使用正斜杠 /
          let relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          results.push(relativePath);
        }
      }
    });
  }

  try {
    recursiveScan(rootDir);
  } catch (e) {
    console.error("Scan assets error:", e);
  }

  return results;
}

  context.subscriptions.push(completionProvider, signatureProvider, assetProvider);
}
