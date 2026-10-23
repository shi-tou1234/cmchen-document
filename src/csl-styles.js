'use strict';
/*
 * 内置 CSL 样式（简化版）。
 *
 * 说明：这三份 XML 是按 CSL 1.0.2 手写的、只使用 src/csl.js 已实现特性的样式，
 * 不是 Zotero 官方样式库的原样拷贝（项目离线开发，拿不到官方文件）。它们覆盖
 *  Vancouver / Nature / Harvard 三种最常见格式，用作「引擎自带样例 + 回归基准」。
 * 需要与投稿要求逐字一致时，请从 zotero.org/styles 下载官方 .csl 再导入：
 * 引擎会按同一套规则解析，且用户样式可以覆盖同名的内置样式。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CslStyles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const styles = [];

  styles.push({
    id: 'vancouver',
    label: 'Vancouver',
    xml: `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US" page-range-format="expanded">
  <info>
    <title>Vancouver</title>
    <id>http://www.zotero.org/styles/vancouver</id>
    <link href="http://www.zotero.org/styles/vancouver" rel="self"/>
    <updated>2024-01-01T00:00:00+00:00</updated>
  </info>
  <macro name="author">
    <names variable="author">
      <name name-as-sort-order="all" sort-separator=" " initialize-with="" delimiter=", " delimiter-precedes-last="always" et-al-min="7" et-al-use-first="6"/>
      <substitute>
        <names variable="editor"/>
      </substitute>
    </names>
  </macro>
  <macro name="issued">
    <date variable="issued">
      <date-part name="year"/>
    </date>
  </macro>
  <citation>
    <layout delimiter=",">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <group delimiter=" ">
        <text variable="citation-number" suffix="."/>
        <text macro="author" suffix="."/>
        <text variable="title" suffix="."/>
        <group delimiter=" ">
          <number variable="edition" form="ordinal"/>
          <text term="edition" form="short"/>
        </group>
        <text variable="container-title" suffix="."/>
        <group delimiter=": ">
          <text variable="publisher-place"/>
          <text variable="publisher"/>
        </group>
        <group delimiter="">
          <choose>
            <if variable="publisher">
              <text macro="issued" prefix="; "/>
            </if>
            <else>
              <text macro="issued"/>
            </else>
          </choose>
          <text variable="volume" prefix=";"/>
          <group prefix="(" suffix=")">
            <text variable="issue"/>
          </group>
          <text variable="page" prefix=":"/>
          <text value="."/>
        </group>
        <choose>
          <if variable="DOI">
            <text variable="DOI" prefix="doi: " suffix="."/>
          </if>
          <else-if variable="URL">
            <text variable="URL" prefix="Available from: "/>
          </else-if>
        </choose>
      </group>
    </layout>
  </bibliography>
</style>`,
  });

  styles.push({
    id: 'nature',
    label: 'Nature',
    xml: `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US" page-range-format="expanded">
  <info>
    <title>Nature</title>
    <id>http://www.zotero.org/styles/nature</id>
    <link href="http://www.zotero.org/styles/nature" rel="self"/>
    <updated>2024-01-01T00:00:00+00:00</updated>
  </info>
  <macro name="author">
    <names variable="author">
      <name name-as-sort-order="all" sort-separator=", " initialize-with=". " delimiter=", " delimiter-precedes-last="always" et-al-min="6" et-al-use-first="1"/>
      <substitute>
        <names variable="editor"/>
      </substitute>
    </names>
  </macro>
  <citation>
    <layout vertical-align="sup">
      <text variable="citation-number"/>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <group delimiter=" ">
        <text variable="citation-number" suffix="."/>
        <text macro="author" suffix="."/>
        <text variable="title" suffix="."/>
        <text variable="container-title" font-style="italic"/>
        <group delimiter="">
          <text variable="volume" font-weight="bold"/>
          <text variable="page" prefix=", "/>
        </group>
        <group prefix="(" suffix=").">
          <date variable="issued">
            <date-part name="year"/>
          </date>
        </group>
        <choose>
          <if variable="DOI">
            <text variable="DOI" prefix="doi:" suffix="."/>
          </if>
          <else-if variable="URL">
            <text variable="URL" prefix="Available from: "/>
          </else-if>
        </choose>
      </group>
    </layout>
  </bibliography>
</style>`,
  });

  styles.push({
    id: 'harvard-cite-them-right',
    label: 'Harvard – Cite Them Right',
    xml: `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-GB" page-range-format="expanded">
  <info>
    <title>Harvard – Cite Them Right</title>
    <id>http://www.zotero.org/styles/harvard-cite-them-right</id>
    <link href="http://www.zotero.org/styles/harvard-cite-them-right" rel="self"/>
    <updated>2024-01-01T00:00:00+00:00</updated>
  </info>
  <macro name="author">
    <names variable="author">
      <name name-as-sort-order="all" sort-separator=", " initialize-with=". " delimiter=", " and="text" delimiter-precedes-last="never" et-al-min="4" et-al-use-first="1"/>
      <substitute>
        <names variable="editor"/>
      </substitute>
    </names>
  </macro>
  <macro name="issued">
    <date variable="issued" prefix="(" suffix=")">
      <date-part name="year"/>
    </date>
  </macro>
  <citation>
    <layout prefix="(" suffix=")" delimiter="; ">
      <group delimiter=", ">
        <names variable="author">
          <name form="short"/>
        </names>
        <date variable="issued">
          <date-part name="year"/>
        </date>
      </group>
    </layout>
  </citation>
  <bibliography>
    <layout>
      <group delimiter=" ">
        <text macro="author" suffix="."/>
        <text macro="issued"/>
        <text variable="title" quotes="true" suffix=","/>
        <group delimiter=" ">
          <number variable="edition" form="ordinal"/>
          <text term="edition" form="short"/>
        </group>
        <text variable="container-title" font-style="italic" suffix=","/>
        <group delimiter="">
          <text variable="volume"/>
          <group prefix="(" suffix=")">
            <text variable="issue"/>
          </group>
          <text value=","/>
        </group>
        <group delimiter=": " suffix=".">
          <text variable="publisher-place"/>
          <text variable="publisher"/>
        </group>
        <group delimiter=" ">
          <label variable="page" form="short"/>
          <text variable="page" suffix="."/>
        </group>
        <choose>
          <if variable="DOI">
            <text variable="DOI" prefix="doi: " suffix="."/>
          </if>
          <else-if variable="URL">
            <text variable="URL" prefix="Available at: " suffix="."/>
          </else-if>
        </choose>
      </group>
    </layout>
  </bibliography>
</style>`,
  });

  return { styles };
});
