// ==UserScript==
// @name         Cut remover
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       You
// @match        https://asus.com/b/*
// @grant        none
// ==/UserScript==

for (const a of document.querySelectorAll("a.vrow.column")) {
  a.href = a.href.replace(/cut=\d+&?/, "");
}
