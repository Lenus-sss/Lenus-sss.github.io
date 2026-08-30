// 先关闭浏览器的文字选择与移动端长按菜单，让所有页面使用同一套复制限制。
const copyProtectionStyle = document.createElement("style");
copyProtectionStyle.textContent = `
  html {
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
`;
document.head.append(copyProtectionStyle);

// 接下来拦截复制入口；这只限制浏览器交互，无法阻止开发者工具或截图获取内容。
const preventBrowserCopy = (event) => event.preventDefault();
["copy", "cut", "contextmenu", "selectstart", "dragstart"].forEach((eventName) => {
  document.addEventListener(eventName, preventBrowserCopy);
});
