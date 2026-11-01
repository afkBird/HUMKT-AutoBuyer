# 云端 Windows 编译步骤

本工程包含 `.github/workflows/build-windows.yml`。GitHub Actions 会在 `windows-latest` runner 上安装 Node.js 24、编译 TypeScript，并使用 Electron Builder 生成 Windows x64 Portable EXE 与 NSIS 安装程序。

1. 在 GitHub 新建 Private repository。
2. 解压 ZIP，将工程所有文件上传到仓库根目录（包括隐藏目录 `.github`）。
3. 进入 Actions，选择 `Build HUMKT Auto Buyer for Windows`。
4. 点击 Run workflow。
5. 工作流完成后，从 Artifacts 下载 `HUMKT-AutoBuyer-V3.0-Windows-x64`。

目标电脑不需要安装 Node.js、npm、Electron、.NET 或 SDK。GitHub 账户需要允许 Actions 执行；私有仓库受账户 Actions 分钟额度限制。
