// 每个页面直接在 data-en/data-zh 中声明文案，这里只负责读取、切换并保存统一语言状态。
const languageToggle = document.querySelector("[data-language-toggle]");
const translatableElements = document.querySelectorAll("[data-en][data-zh]");
const languageGroups = document.querySelectorAll("[data-language]");

function applyLanguage(language) {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = document.body.dataset[`title${language === "zh" ? "Zh" : "En"}`];

  translatableElements.forEach((element) => {
    element.textContent = element.dataset[language];
  });

  languageGroups.forEach((group) => {
    group.hidden = group.dataset.language !== language;
  });

  languageToggle.setAttribute(
    "aria-label",
    language === "zh" ? "切换为英文" : "Switch to Chinese"
  );
  localStorage.setItem("lenus-language", language);
}

let currentLanguage = localStorage.getItem("lenus-language") === "zh" ? "zh" : "en";
applyLanguage(currentLanguage);

languageToggle.addEventListener("click", () => {
  currentLanguage = currentLanguage === "en" ? "zh" : "en";
  applyLanguage(currentLanguage);
});
