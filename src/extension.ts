import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const selector = ["javascript", "typescript"];

interface CodeItem {
  label: string;
  kind: string;
  detail: string;
  documentation: string;
  sourceDescription?: string;
}

export function activate(context: vscode.ExtensionContext) {
  // --- 1. 动态合并所有数据源 ---
  const dataPath = path.join(context.extensionPath, "data");
  let combinedData: CodeItem[] = [];

  try {
    const files = fs
      .readdirSync(dataPath)
      .filter((file) => file.endsWith(".json"));

    combinedData = files.flatMap((file) => {
      const filePath = path.join(dataPath, file);
      const rawData = fs.readFileSync(filePath, "utf8");
      const jsonData = JSON.parse(rawData) as CodeItem[];
      const description = formatFileNameToDescription(file);

      return jsonData.map((item) => ({
        ...item,
        sourceDescription: description,
      }));
    });
  } catch (err) {
    console.error("读取数据文件失败:", err);
  }

  function formatFileNameToDescription(fileName: string): string {
    return fileName
      .replace(".json", "")
      .split("-")
      .map((word) => {
        if (word.toLowerCase() === "api") return "API";
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ");
      // .replace(/^/, "MTR ");
  }

  // --- 优化点 1: 预先缓存所有代码补全项 (避免每次触发都重新创建上千个对象) ---
  const cachedCompletionItems = combinedData.map((item) => {
    const signatureLabel = item.detail.includes("(")
      ? item.detail.substring(item.detail.indexOf("("))
      : "";

    const completion = new vscode.CompletionItem({
      label: item.label,
      detail: signatureLabel,
      description: item.sourceDescription,
    });

    let isCallable = false;
    if (item.kind === "Method") {
      completion.kind = vscode.CompletionItemKind.Method;
      isCallable = true;
    } else if (item.kind === "Class") {
      completion.kind = vscode.CompletionItemKind.Class;
    } else {
      completion.kind = vscode.CompletionItemKind.Function;
      isCallable = true;
    }

    if (isCallable) {
      completion.insertText = new vscode.SnippetString(`${item.label}($1)`);
      completion.command = {
        title: "triggerParameterHints",
        command: "editor.action.triggerParameterHints",
      };
    } else {
      completion.insertText = item.label;
    }

    // 注意：这里没有设置 completion.documentation，以节省内存
    return completion;
  });

  // 获取 Label 的辅助函数 (兼容 VS Code 的 CompletionItemLabel 接口)
  const getLabelString = (label: string | vscode.CompletionItemLabel) =>
    typeof label === "string" ? label : label.label;

  /**
   * 第一部分：代码补全 (IntelliSense)
   */
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems(document, position) {
        // 简单的前端过滤，减少 IPC 通信开销
        const range = document.getWordRangeAtPosition(position);
        const prefix = range ? document.getText(range).toLowerCase() : "";

        if (!prefix) return cachedCompletionItems; // 没输入时返回全部

        // 仅返回匹配当前输入前缀的条目
        return cachedCompletionItems.filter((item) => {
          const labelStr = getLabelString(item.label).toLowerCase();
          return labelStr.includes(prefix);
        });
      },

      // --- 优化点 2: 懒加载文档 (仅当用户悬浮或选中该项时才解析 Markdown 文档) ---
      resolveCompletionItem(item) {
        const labelStr = getLabelString(item.label);
        const originalData = combinedData.find((d) => d.label === labelStr);

        if (originalData && originalData.documentation) {
          item.documentation = new vscode.MarkdownString(
            originalData.documentation,
          );
        }
        return item;
      },
    },
  );

  /**
   * 第二部分：参数提示 (Parameter Hints)
   * (保持原有逻辑不变)
   */
  const signatureProvider = vscode.languages.registerSignatureHelpProvider(
    selector,
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
   * --- 优化点 3: 全新的一套基于 vscode API 的异步缓存扫描方案 ---
   */
  let assetCache: vscode.CompletionItem[] = [];

  // 异步扫描函数，不阻塞主线程
  async function updateAssetCache() {
    // 只有在打开了工作区的情况下才扫描
    if (!vscode.workspace.workspaceFolders) return;

    try {
      // 使用 VS Code 内置的异步 API，排除 node_modules 和 .git
      const files = await vscode.workspace.findFiles(
        "**/*.{png,obj,bbmodel,json,ogg,csv}",
        "**/{node_modules,.git}/**",
      );

      assetCache = files.map((uri) => {
        // 转换为相对路径，并统一使用正斜杠
        let relativePath = vscode.workspace.asRelativePath(uri, false);
        const item = new vscode.CompletionItem(
          relativePath,
          vscode.CompletionItemKind.File,
        );
        item.detail = "MTR Asset Resource";
        return item;
      });
    } catch (e) {
      console.error("扫描资产文件失败:", e);
    }
  }

  // 插件激活时触发一次异步扫描
  updateAssetCache();

  // 创建文件监听器，当有新增/删除合法后缀文件时，自动更新缓存
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/*.{png,obj,bbmodel,json,ogg,csv}",
  );
  watcher.onDidCreate(() => updateAssetCache());
  watcher.onDidDelete(() => updateAssetCache());

  const assetProvider = vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
      ) {
        const linePrefix = document
          .lineAt(position)
          .text.substr(0, position.character);
        const quoteMatch = linePrefix.match(/["']([^"']*)$/);
        if (!quoteMatch) return undefined;

        const currentInput = quoteMatch[1].toLowerCase();

        // 返回缓存的数据（如果用户输入了部分路径，进行过滤）
        if (!currentInput) return assetCache;

        return assetCache.filter((item) => {
          const labelStr = getLabelString(item.label).toLowerCase();
          return labelStr.includes(currentInput);
        });
      },
    },
    '"',
    "'",
    "/",
  );

  // 注册所有 Provider 并监听 watcher，确保插件卸载时正确释放内存
  context.subscriptions.push(
    completionProvider,
    signatureProvider,
    assetProvider,
    watcher,
  );
}
