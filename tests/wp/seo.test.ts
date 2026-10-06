import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { fromHtml } from "hast-util-from-html";
import { serialize } from "php-serialize";
import { createReport } from "../../src/report.ts";
import type {
  Report,
  ReportEntry,
  WpAttachment,
  WpModel,
  WpPost,
  WpSite,
  WpTerm,
  WpUser,
} from "../../src/types.ts";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { BASE_PROPERTIES, loadAcf } from "../../src/wp/acf.ts";
import { openDb } from "../../src/wp/db.ts";
import { decodeEntities, loadModel } from "../../src/wp/model.ts";
import {
  php,
  type RankMathVars,
  renderRankMathTemplate,
  type Seo,
  seoFor,
  type SeoTarget,
  toEntrySeo,
} from "../../src/wp/seo.ts";
import { fixtureDb, fixtureDir } from "../helpers/fixture-db.ts";

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

// ── Data from the real sites ─────────────────────────────────────────────────────────────────────

type Site = "fineline" | "ap";

async function load(site: Site): Promise<WpModel> {
  const { url, prefix } = await fixtureDb(site);
  const db = await openDb(url, { prefix });
  try {
    return await loadModel(db);
  } finally {
    await db.close();
  }
}

const models = {} as Record<Site, WpModel>;

beforeAll(async () => {
  [models.fineline, models.ap] = await Promise.all([load("fineline"), load("ap")]);
});

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");
const codes = (report: Report, code: string): ReportEntry[] =>
  report.entries().filter((e) => e.code === code);

/**
 * Answers recorded from PHP and from the live sites, as data:
 * - `ports`, `replacer`, `excerptMd5`: what WordPress's own `wpautop`, `wp_kses`, `strip_tags`, `date()` and Rank Math's
 *   `Replacer`, `Str::truncate` and `Post_Variables::get_post_content` answered for these inputs (WordPress 6.8 and
 *   Rank Math 1.0.253 run under PHP 8.3, with a few stubs for what they call outside of WordPress; the sites run 1.0.278 and
 *   1.0.279, whose title, description, robots, Open Graph and replacer code differs from 1.0.253 only in the text domain, an added
 *   `Singular::get_seo_meta()` and `Str::substr()`, so the answers hold for them);
 * - `live`: md5 of the title, description, robots and og:image file name that each live page printed on 2026-10-01.
 */
const GOLDEN = JSON.parse(
  String.raw`{"excerptMd5":{"fineline":{"22":"47bcb09febba","23":"cd5ef56ca3b8","30":"3f95e047bfa0","60":"30739ba7f2c4","63":"5b67cea46023","189":"758baa12b5d2","195":"2327479385ea","272":"065ad608bf69","276":"d9cc808099d2","278":"065ad608bf69","279":"065ad608bf69","280":"065ad608bf69","283":"d9cc808099d2","297":"3f7916415b62","338":"480aea682e13","690":"15ef0506a0f4","916":"24dde588a024","960":"213ab4e8a3cc","1013":"8b9290b0bc20","1077":"29bcb1b9e881","1078":"8c1e294554ea","1107":"df318e922340","1110":"7db28e4b619b","1118":"cdf4c5014cb6","1329":"0b759aa09722","1334":"4c605389f7cf","1336":"9b85803fd8b0","1337":"4a3eef9d52d4","1377":"c6994439c16e","1382":"7bdf1cbf5ff6","1528":"8c464cb97df6","1558":"09d62abecf0e","1560":"aeee0e403767","1563":"ef304eac7e34","1599":"496d83ed3339","1613":"c51ad8cb85d6","1621":"4785b128b9e5","1626":"88ecf819d81c","1633":"04b9a925e312","1661":"6fdcc91c99aa","1662":"3f20b32998c3","1663":"5e93aa0bcd03","1664":"868d2f12e990","1669":"301043324201","1714":"46c5376692a5","1716":"bd324ca2b88f","1751":"e0971c8aaaa2","1840":"5cd37b45747d","1859":"0be1ec96d45d","1933":"06ca43e03905","1935":"39ee2f0bf5de","1937":"a61ab455de34","1939":"5e5fbc5251ee","1941":"b592da7cef7a","1988":"ca5f2b12755f","1991":"9edbea7b806d","2000":"40827a7ffc9f","2012":"8b3329b76fed","2075":"12bfd4cac318","2100":"e1969d0ae444","2102":"6c5464994525","2104":"7c209d65d61b","2197":"df48fc05c1c8","2201":"81b7efe6b2b3","2284":"8b14f82ec270","2285":"f9cd990fef3c","2286":"690d6c629f1c","2416":"af2d838e574c","2417":"278ae40ffc1e","2437":"7327c8320dfc","2438":"3864ce5ee484","2449":"e6ec95fad876","2455":"6bf226d74e2b","2469":"308d5425a3e6","2475":"70c516b20ba5","2485":"7a453c3806db","2559":"9ad88d64256e","2592":"f92da26f5480","2602":"6fe37572e196","2610":"cf747ed85af4","2611":"fa62c256daee","2613":"278ae40ffc1e","2614":"278ae40ffc1e","2615":"fa62c256daee","2804":"f33a15b2fb08","2837":"d60e0f565c9d","2842":"f275cd602f89","2882":"c6c72bfed7b6","2908":"30b3a6ee5999","2910":"a3b8ac7298fe","2914":"f4889516028d","2920":"434e37306de0","2922":"82497b89c188","2967":"2370a3929c71","2976":"af9b544e99d9","2988":"13d24846a731","3190":"244741152658","3193":"5584394c1603","3271":"2ad05e4f7249","3371":"49b10eb9c304","3483":"a1822ff06fdb","3518":"e64e361c0fe4","3579":"1a32ee497cc0","3698":"32f2d600f2dc","3717":"22d5ab15d7a3","3721":"3db616cd690c","3741":"e439cc052115","3750":"c9907af02170","3753":"8441fcc95bae","3755":"8d0e6b6340f1","3871":"31fe7bebe5e0","3876":"72ed250c37e8","3881":"65db8b6b54bd","3889":"d6cc0964fa5b","3890":"1aa40ffff6d3","3968":"582d3cd2e508","4069":"858b5bdb6fad","4071":"b0526ef0d643","4084":"de749e8c4804","4145":"a59e6029f503","4203":"5809ab115619","4211":"0f83c11accbe","4360":"b2b80d9671fb","4396":"d5586447dd7c","4470":"a93f667b1fee","4483":"17a714a5ddc3","4500":"6ee63c567434","4505":"5075029570f9","4507":"2a1511684607","4572":"02ca15b0231b","4582":"fb4cc9cec255","4613":"04bd88cc946e","4625":"1acb99fe97ab","4649":"b47e408db743","4692":"5e93aa0bcd03","4698":"f765410e80fb","4703":"5e93aa0bcd03","4704":"5e93aa0bcd03","4705":"5e93aa0bcd03","4708":"dafa3afef4a5","4717":"decb9f63b2c0","4733":"ab3abd479ce7","4750":"f765410e80fb","4751":"f765410e80fb","4752":"f765410e80fb","4775":"c576406a66c9","5005":"bced497cbedf","5007":"6c6ff3c404c1","5011":"d11e36db2065","5014":"c5c323a4a530","5016":"6e63365de317","5018":"9bc83ce655ac","5107":"cdff67b4250a","5108":"6c4b32335bfc","5109":"2ad05e4f7249","5110":"33e43ecb321b","5111":"2ad05e4f7249","5112":"33e43ecb321b","5113":"2ad05e4f7249","5114":"33e43ecb321b","5115":"f8caf7a59e03","5116":"6c4b32335bfc","5117":"2ad05e4f7249","5119":"11ad4ab991f4","5120":"2ad05e4f7249","5122":"11ad4ab991f4","5123":"2ad05e4f7249","5125":"11ad4ab991f4","5126":"2ad05e4f7249","5128":"11ad4ab991f4","5129":"f8caf7a59e03","5130":"2ad05e4f7249","5131":"11ad4ab991f4","5132":"2ad05e4f7249","5145":"2ad05e4f7249","5174":"2ad05e4f7249","5181":"96a46f10921c","5184":"2ad05e4f7249","5216":"b9103dbb76e6","5218":"11ad4ab991f4","5219":"96a46f10921c","5246":"981ceeeba51f","5260":"42189ed38b3e","5267":"5eed0f5241e4","5270":"4aa316d4c6c1","5272":"8d30b0f12862","5274":"32b82850269e","5276":"7c97debd5131","5278":"18d090e7af08","5280":"50d5b2e72fd8","5282":"a6e9049e5258","5289":"a0540d804ea1","5291":"6e31a2e30591","5293":"46f4ddd5dc21","5295":"8e3e7bcae448","5297":"a335047822f2","5299":"fcacd5852897","5301":"744efc8a3b15","5303":"7e36aa9b97aa","5305":"c24af2f8aa9f","5307":"44e6fb6c328b","5309":"384a64ae0743","5311":"0e2abc2ef6d5","5312":"0334e3d7e3a6","5349":"0dcf78f51de7","5368":"6c4b32335bfc","5369":"cbe19e11a32c","5370":"77e96b0c40d9","5384":"e324cdad5148","5386":"f8caf7a59e03","5390":"e324cdad5148","5400":"96a46f10921c","5405":"96a46f10921c","5586":"73721821e8cd","5616":"f489bc0c7856","5617":"2ad05e4f7249","5619":"2ad05e4f7249","5620":"2ad05e4f7249","5621":"8ee08770e925","5622":"2ad05e4f7249","5623":"8ee08770e925","5624":"2ad05e4f7249","5625":"8ee08770e925","5626":"2ad05e4f7249","5812":"96a46f10921c","5813":"2ad05e4f7249","5814":"2ad05e4f7249","5815":"2ad05e4f7249","6027":"c6d4b3d46b37","6069":"93b885adfe0d","6086":"b36ede11e07a","6090":"1703d2417261","6100":"11ad4ab991f4","6113":"93b885adfe0d","6129":"93b885adfe0d","6130":"93b885adfe0d","6131":"93b885adfe0d","6327":"d9a235cc4aee","6395":"8cf6f8c9b544","6502":"ccae3597aa3b","6534":"f181e4b27552","6541":"0740e85a94c7","6543":"c1615ca376d4","6581":"f1f2ff4521cd","6754":"5166c0300b7f","6833":"34639d2719a8"},"ap":{"1":"3f7916415b62","2":"3f7916415b62","3":"d1934b4de4f8","4":"dd4a8afbd6eb","5":"6b058cf6e8d5","6":"fdf67b75a503","7":"f09bf3192198","8":"7bde34b44353","9":"98c47d2fe265","10":"95e462bfaac3","11":"1c3a7c44e8f1","12":"9aba12ec55d2","13":"303ef0734b80","668":"1c4b1d7cdba4","669":"cc22b6ab5365","672":"c55f965e9c2f","673":"9d102e6715ed","674":"0e36a03adb97","675":"7a9f25a61dd0","677":"a6029c3f5934","678":"ebf657cb6440","679":"8473895d7bb6","680":"c14af29c0a45","682":"55bed085a08a","683":"6b5e6293c282","684":"0e36a03adb97","685":"14f8a86a351e","686":"00a7ab187992","687":"03182a4d6f02","688":"b84ebcab0d94","689":"696c49b7401e","690":"b84ebcab0d94","691":"a6029c3f5934","731":"cbf312b9293a","732":"4b3ba105863a","733":"e2fe2fa08391","734":"0a92d8f3c6bb","735":"f11236f6258a","736":"04b76cb6fd90","737":"646424810798","738":"3be9eb5ba1b2","742":"b5e119cbc688","743":"05db3bf0263e","746":"ad9f93fd5f23","747":"804237382fd7","749":"db6a6c7f7d24","750":"6c8de4bd0acc","752":"bf17912183f1","753":"d888fc792bbe","754":"3c878adad170","755":"ec6974746a01","756":"aa80587acb24","757":"0d62adb48e38","758":"52fe2db671bb","760":"1faa504a67b9","761":"27d4defb60c5","762":"4bd5de1a261d","763":"816e453e6554","764":"2e5ea0487dfd","765":"f78e449c8a0f","766":"8146729c3705","767":"3aabb8a7d914","769":"e198397d6f87","771":"8cec90c5912d","772":"f14a87b70160","773":"c21ee9edaff9","774":"ef2068a005d4","775":"35b666f9f866","776":"a8d9898e1a2e","777":"12adbfded5e9","779":"395a3da174a2","780":"9537b537b1ec","781":"e1768d163ee2","783":"459e743b32aa","784":"f4c4700ad2a8","786":"9aa31edc7b4e","788":"338849304807","790":"5ca0dee9f7cc","792":"af452ff52ffd","794":"142df30b7f10","796":"c4ee4844ada9","797":"0ae327ac2950","798":"1cde7e3aca74","801":"53224a27a6f8","803":"50c7e33b4fd7","804":"ffa46d7280bf","806":"adad092c60a9","808":"9042f7f53d1b","810":"15ea17d88935","812":"7d0e28a6fb9c","814":"ce6b715ed497","816":"ebbf8ccf6137","817":"ef47387d090d","819":"f6db5ac13f2c","822":"22d715c74675","823":"ba9609d2a8db","826":"004903ae42ab","827":"71f09d883e90","830":"ba4471362ac2","833":"4445f80b998b","834":"55eebe3b4fdc","835":"3a3144799bae","836":"d0bba2a34271","837":"ec7fa99098c1","838":"7602d17fa219","839":"7883e4bcc154","840":"acec98ce3dd7","1069":"551cae43e4ac","1081":"606755f9cfdb","1085":"b338fcd1ce0d","1086":"a6c0ef7d0ea8","1087":"2a3cdbd61b43","1090":"8abc9f4e133b","1094":"d168491a2d92","1097":"e52c3fefea39","1103":"7d37abf999ce","1108":"ce435880e193","1293":"b01608ef85a3","1296":"1f1fced92fdc","1370":"f898c6550925","1415":"227a733661c0","1417":"505a9a593c22","1471":"3f001e30f483","1478":"aea50f748a77","1551":"ab717d5fd086","1590":"c707f1f25df8","1872":"93b885adfe0d","1875":"af0488364f9c","1882":"93b885adfe0d","1883":"93b885adfe0d","1884":"93b885adfe0d","1885":"93b885adfe0d","1886":"93b885adfe0d","1887":"93b885adfe0d","1888":"93b885adfe0d","1889":"93b885adfe0d","1890":"93b885adfe0d","1891":"93b885adfe0d","1892":"93b885adfe0d","1894":"284e40a0cc6b","1899":"93b885adfe0d","2176":"cab4fb61ba78","2182":"caaf9902c9d9","2332":"766030655430","2410":"7b1c44b40adf","2414":"51273cf5aaac","2430":"d4576d168b38","2438":"4f8cefc3dc1b","2598":"45e8dbee3634","2790":"ac654d3e284b","2882":"52de9783f452","2897":"d8c1272dd6ee","2915":"2ba203e85892","2935":"ead345398b5b","3501":"173d9dc0becd","3508":"99e2ac064611","3621":"2a9739ef2300","3650":"447ac04e6696","3742":"14d271eae373","3744":"23427c31e89a","3794":"295319a6ef2e","3901":"db0e30074f94","4132":"e560f492a507","4135":"568cb485bcac","4272":"160e3e03c41b","4300":"129685654fd7","4320":"20301cfeb635","4366":"e13ba54bca6d","4384":"ac71c6830188","4452":"6d4d0e805daf","4473":"bb79a58924eb","4502":"f1c4038a47b5","4721":"81ef485ff269","4796":"a30576d041b6","4894":"282108c694fd","4924":"e6b87005c82f","4985":"6b403819f4e1","5046":"b37c48fbc08d","5147":"f8b44d1fa381","5229":"02fdeba6292d","5421":"dae804ba8f78","5488":"74b867a1bf2a","5489":"1718f5edece4","5602":"9b470848a0b1","5629":"d68653f51859","5669":"fb5c482d2889","5744":"206a5198a33d","5813":"1302fbb1a5fe","5877":"c54b0722b97f","5936":"01517e4a4ea1","5938":"767b7526267a","5939":"81a3833200a6","5963":"0a4b13b5cf1b","6037":"2b25a53a2f60","6110":"68d316385c9d","6291":"41c33d04830b","6433":"79e007ac3793","6513":"58b8a7bb93ab","6583":"2c404950094e","6679":"a844fda8986e","6708":"9e8a63e34ded","6854":"d979c3d912d2","6958":"cdcb03f20e58","7048":"f81f5159649c","7102":"0710c9ca408f","7260":"0f9893a7544e","7367":"f6ecda075f85","7369":"f646b4dad64e","7371":"206869da359e","7373":"c9e439f4b725","7378":"0ce0759ef93e","7426":"7e524cce6dba","8382":"a9905f62164b","8641":"7d62622db535","8819":"60aa292a1df1","10455":"73a399ffd11c","10457":"7575b05a81b0","10545":"3219efdbdbc6","10776":"d9fcc0a607b4","10791":"53b6611274aa","11028":"f563a9c51d43","11218":"1db799ced296","11319":"223a76e5ca38","11345":"981e85dac5b4","11346":"3ff7f0152ec9","11401":"af424de7d906","11515":"5c14f2d4c089","11516":"d26cbd76ddf3","11550":"a2ad99329eca","11574":"2f5c278fde7e","11610":"41add6f3d96e","11654":"d40ee31a2016","11669":"cf8f17765071","11678":"d54da5fe7706","11688":"e12fef7d7a6b","11731":"a383d6210e8e","11814":"b613fc0c405c","11839":"a3810c4394d4","11848":"dcf5c17052d6","11896":"ae4e175f0490","11911":"5a329774d5cb","11945":"a16a13700d1d","11963":"cb78065c753c","11976":"1dc561c60c66","11984":"a1ded06999d6","12053":"7b14bc9dfac6","12057":"5dc0f7301612","12088":"812ccd75bbca","12126":"b74b570b068e","12282":"a59952786dc3","12372":"f30aee9d95a3","12403":"961b9e2c18d8","12485":"851ebd8fe9dc","12549":"37a62adc5587","12556":"321860559ea8","12670":"ac562419698a","12674":"ee4f0de46285","12686":"434b4990c8a4","12692":"0a96782f1c3f","12714":"32f69f76fd47","12784":"85b45f235cc6","12851":"ba25c74eb893","13041":"6018e5302897","13154":"e868ebcd15df","13325":"1164aa6f23f5","13379":"3f8db63e1b4b","13384":"a7d3f90329ce","13419":"6797e9e6947f","13440":"3a1df9418ae0","13502":"f3472ba2feff","13503":"8d6541dc6e77","13504":"9321f135d5ce","13536":"882e02e53e05","13671":"9aba12ec55d2","13675":"2c152919ade6","13742":"74e0d7bc4f1d","13990":"5c8267c0a939","14058":"93602adef0af","14079":"93b885adfe0d","14135":"b840bc8ebfe6","14136":"14ed66dcfe8f","14266":"ebd96389f7d3","14304":"b544f2f02591","14311":"8a6539cba506","14317":"dc153a445322","14358":"12af19c756a0","14454":"0bbf65e84da0","14593":"38334a3dc1fa","14658":"252d3e2aafd6","14694":"948dfe9ac2fb","14706":"2ce4cc0aaaf3","14719":"47a91ab10638","14754":"bfe19d2b7765","14776":"545446f1a04c","14786":"0d81ff8df076","14823":"88ac45a86bd3","14888":"0d369b586e7f","14896":"67cf4d0174a6","14913":"383a38b807d9","14947":"c5ae088630db","14963":"913b4ac1ec9a","15055":"770b00d2f3b7","15093":"f7f98b4d8434","15121":"1e481f1ed39f","15122":"ceb8e3809e01","15123":"4fced5691d60","15156":"95e4be5d701c","15232":"5e4fd62c217f","15256":"e265df814576","15318":"a99f4ef3d874","15338":"98180428d0dc","15414":"a4a1046fcf7c","15457":"1371399cbf69","15474":"7c9ccae22701","15480":"b62db7c16b93","15507":"059c619184dc","15543":"d42381df9854","15559":"9e9dc2b4c0c9","15634":"14cb43b4b692","15726":"03abef4b5024","15745":"ffc728d3a45d","15769":"5ba20980224f","15793":"82eee09dc794","15818":"5d5ca8b413f1","15884":"dcd857ab47d6","15936":"c247c3d6c53d","15955":"04dfbb204fc8","16014":"dc4f1155d22d","16016":"5e6be4351d40","16091":"4791ac23e17e","16138":"c4cdaa12d18c","16151":"f24a0bf972ee","16171":"ea07994f1604","16183":"d528525202d3","16196":"ac2d68b69acc","16202":"a724f9f84abd","16213":"8aed396fd726","16248":"974565ef43c4","16260":"37b7ea97e1c7"}},"ports":{"inputs":["plain text","a\n\nb\n\nc","a\r\nb\r\n\r\nc","line1\nline2","<div>x</div>","<p>x</p><p>y</p>","<ul><li>a</li><li>b</li></ul>","<pre>keep\n\nthis</pre> after","<br><br>x","a < b and c > d","<script>alert(1)</script>text","<style>p{}</style> t","x<!-- c -->y","5 > 3 &amp; 2 < 4","&nbsp;&hellip;&apos;&bogus;&#8217;&#x2019;&#0;","<p class=\"a\">q</p>","<P>upper</P>","text [shortcode a=1] more [/shortcode]","[caption id=\"a\"]<img src=x> cap[/caption] after","<blockquote>quote\n\nmore</blockquote>","<table><tr><td>cell</td></tr></table>","<a href=\"x>y\">link</a> tail","<img alt='a>b' src=x> t","<?php echo 1; ?> x","<!DOCTYPE html> y","a<b","a>b","tab\there\n\n\n\nbreak"," nbsp  inside","<figure><img src=x><figcaption>cap</figcaption></figure>\n\ntext","<h2>Heading</h2>\ntext after heading\nmore","<svg><path d=\"M0\n0\"/></svg>\n\ntext","﻿","<p>﻿</p>","<!-- wp:paragraph -->\n<p>Hello <a href=\"/x\">link</a></p>\n<!-- /wp:paragraph -->"],"wpautop":["<p>plain text</p>\n","<p>a</p>\n<p>b</p>\n<p>c</p>\n","<p>a<br />\nb</p>\n<p>c</p>\n","<p>line1<br />\nline2</p>\n","<div>x</div>\n","<p>x</p>\n<p>y</p>\n","<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n","<pre>keep\n\nthis</pre>\n<p> after</p>\n","<p>x</p>\n","<p>a < b and c > d</p>\n","<p><script>alert(1)</script>text</p>\n","<style>p{}</style>\n<p> t</p>\n","<p>x<!-- c -->y</p>\n","<p>5 > 3 &amp; 2 < 4\n</p>\n","<p>&nbsp;&hellip;&apos;&bogus;&#8217;&#x2019;&#0;</p>\n","<p class=\"a\">q</p>\n","<p><P>upper</P></p>\n","<p>text [shortcode a=1] more [/shortcode]</p>\n","<p>[caption id=\"a\"]<img src=x> cap[/caption] after</p>\n","<blockquote><p>quote</p>\n<p>more</p></blockquote>\n","<table>\n<tr>\n<td>cell</td>\n</tr>\n</table>\n","<p><a href=\"x>y\">link</a> tail</p>\n","<p><img alt='a>b' src=x> t</p>\n","<p><?php echo 1; ?> x</p>\n","<p><!DOCTYPE html> y</p>\n","<p>a<b\n</p>\n","<p>a>b</p>\n","<p>tab\there</p>\n<p>break</p>\n","<p> nbsp  inside</p>\n","<figure><img src=x><figcaption>cap</figcaption></figure>\n<p>text</p>\n","<h2>Heading</h2>\n<p>text after heading<br />\nmore</p>\n","<p><svg><path d=\"M0\n0\"/></svg></p>\n<p>text</p>\n","<p>﻿</p>\n","<p>﻿</p>\n","<p><!-- wp:paragraph --></p>\n<p>Hello <a href=\"/x\">link</a></p>\n<p><!-- /wp:paragraph --></p>\n"],"kses":["plain text","a\n\nb\n\nc","a\r\nb\r\n\r\nc","line1\nline2","x","<p>x</p><p>y</p>","ab","keep\n\nthis after","x","a  d","alert(1)text","p{} t","x<!-- c -->y","5 &gt; 3 &amp; 2 ","&nbsp;&hellip;&apos;&amp;bogus;&#8217;&#x2019;&amp;#0;","<p>q</p>","<P>upper</P>","text [shortcode a=1] more [/shortcode]","[caption id=\"a\"] cap[/caption] after","quote\n\nmore","cell","y\"&gt;link tail","b' src=x&gt; t"," x"," y","a","a&gt;b","tab\there\n\n\n\nbreak"," nbsp  inside","cap\n\ntext","Heading\ntext after heading\nmore","\n\ntext","﻿","<p>﻿</p>","<!-- wp:paragraph -->\n<p>Hello link</p>\n<!-- /wp:paragraph -->"],"stripTags":["plain text","a\n\nb\n\nc","a\r\nb\r\n\r\nc","line1\nline2","x","xy","ab","keep\n\nthis after","x","a < b and c > d","alert(1)text","p{} t","xy","5 > 3 &amp; 2 < 4","&nbsp;&hellip;&apos;&bogus;&#8217;&#x2019;&#0;","q","upper","text [shortcode a=1] more [/shortcode]","[caption id=\"a\"] cap[/caption] after","quote\n\nmore","cell","link tail"," t"," x"," y","a","a>b","tab\there\n\n\n\nbreak"," nbsp  inside","cap\n\ntext","Heading\ntext after heading\nmore","\n\ntext","﻿","﻿","\nHello link\n"],"stripAllTags":["plain text","a b c","a b c","line1 line2","x","xy","ab","keep this after","x","a < b and c > d","text","t","xy","5 > 3 &amp; 2 < 4","&nbsp;&hellip;&apos;&bogus;&#8217;&#x2019;&#0;","q","upper","text [shortcode a=1] more [/shortcode]","[caption id=\"a\"] cap[/caption] after","quote more","cell","link tail","t","x","y","a","a>b","tab here break"," nbsp  inside","cap text","Heading text after heading more","text","﻿","﻿","Hello link"],"stripShortcodes":["plain text","a\n\nb\n\nc","a\r\nb\r\n\r\nc","line1\nline2","<div>x</div>","<p>x</p><p>y</p>","<ul><li>a</li><li>b</li></ul>","<pre>keep\n\nthis</pre> after","<br><br>x","a < b and c > d","<script>alert(1)</script>text","<style>p{}</style> t","x<!-- c -->y","5 > 3 &amp; 2 < 4","&nbsp;&hellip;&apos;&bogus;&#8217;&#x2019;&#0;","<p class=\"a\">q</p>","<P>upper</P>","text  more ","after","<blockquote>quote\n\nmore</blockquote>","<table><tr><td>cell</td></tr></table>","<a href=\"x>y\">link</a> tail","<img alt='a>b' src=x> t","<?php echo 1; ?> x","<!DOCTYPE html> y","a<b","a>b","tab\there\n\n\n\nbreak"," nbsp  inside","<figure><img src=x><figcaption>cap</figcaption></figure>\n\ntext","<h2>Heading</h2>\ntext after heading\nmore","<svg><path d=\"M0\n0\"/></svg>\n\ntext","﻿","<p>﻿</p>","<!-- wp:paragraph -->\n<p>Hello <a href=\"/x\">link</a></p>\n<!-- /wp:paragraph -->"],"excerpt":["plain text","a","c","<p>line1\nline2</p>\n","x\n","x","\na\nb\n\n"," after","x","a  d","alert(1)text"," t","xy","<p>5 &gt; 3 &amp; 2 \n","&nbsp;&hellip;&apos;&amp;bogus;&#8217;&#x2019;&amp;#0;","q","<P>upper</P>","text  more ","after","quote","\n\ncell\n\n\n","y\"&gt;link tail","b' src=x&gt; t"," x"," y","<p>a\n","a&gt;b","tab\there"," nbsp  inside","text","Heading\n<p>text after heading\nmore</p>\n","text","﻿","﻿","Hello link"],"truncate":[["Look at this &amp; that &hellip; the quick brown fox jumps over the lazy dog and keeps running through the forest until the very end of the day ok",60,"Look at this &amp; that &hellip; the quick brown fox jumps"],["éééé éééé ééé",7,"éééé"],["x &amp",4,""],["a b &nbsp",8,"a"],["one two three",8,"one"],["nospaces",4,""],["short",160,"short"],["<b>bold</b> words here",9,"bold"]],"ucwords":[["hello wORLD 3d é ñandú","Hello WORLD 3d é ñandú"],["  multiple   spaces ","  Multiple   Spaces "],["123 abc","123 Abc"],["élan vital","élan Vital"],["(parens) [x] -dash","(parens) [x] -dash"],["1.5 two","1.5 Two"]],"keyword":[["<p>Find the keyword here</p><p>other</p>","keyword","Find the keyword here"],["<p>a</p><p>needle haystack</p>","needle, other","needle haystack"],["<p>a (b</p><p>second</p>","(b","a (b"],["<p>x/y z</p><p>q</p>","x/y","x/y z"],["<p>First</p><p>Second keyword</p>","KEYWORD","Second keyword"],["<p>one two</p><p>three</p>","one two","one two"]],"dates":[["F j, Y",1700000000,"America/New_York","November 14, 2023"],["F j, Y",1720000000,"America/New_York","July 3, 2024"],["F j, Y",1735689600,"America/New_York","December 31, 2024"],["F j, Y",1700000000,"UTC","November 14, 2023"],["F j, Y",1720000000,"UTC","July 3, 2024"],["F j, Y",1735689600,"UTC","January 1, 2025"],["F j, Y",1700000000,"Europe/London","November 14, 2023"],["F j, Y",1720000000,"Europe/London","July 3, 2024"],["F j, Y",1735689600,"Europe/London","January 1, 2025"],["F j, Y",1700000000,"Asia/Kolkata","November 15, 2023"],["F j, Y",1720000000,"Asia/Kolkata","July 3, 2024"],["F j, Y",1735689600,"Asia/Kolkata","January 1, 2025"],["g:i a",1700000000,"America/New_York","5:13 pm"],["g:i a",1720000000,"America/New_York","5:46 am"],["g:i a",1735689600,"America/New_York","7:00 pm"],["g:i a",1700000000,"UTC","10:13 pm"],["g:i a",1720000000,"UTC","9:46 am"],["g:i a",1735689600,"UTC","12:00 am"],["g:i a",1700000000,"Europe/London","10:13 pm"],["g:i a",1720000000,"Europe/London","10:46 am"],["g:i a",1735689600,"Europe/London","12:00 am"],["g:i a",1700000000,"Asia/Kolkata","3:43 am"],["g:i a",1720000000,"Asia/Kolkata","3:16 pm"],["g:i a",1735689600,"Asia/Kolkata","5:30 am"],["Y-m-d",1700000000,"America/New_York","2023-11-14"],["Y-m-d",1720000000,"America/New_York","2024-07-03"],["Y-m-d",1735689600,"America/New_York","2024-12-31"],["Y-m-d",1700000000,"UTC","2023-11-14"],["Y-m-d",1720000000,"UTC","2024-07-03"],["Y-m-d",1735689600,"UTC","2025-01-01"],["Y-m-d",1700000000,"Europe/London","2023-11-14"],["Y-m-d",1720000000,"Europe/London","2024-07-03"],["Y-m-d",1735689600,"Europe/London","2025-01-01"],["Y-m-d",1700000000,"Asia/Kolkata","2023-11-15"],["Y-m-d",1720000000,"Asia/Kolkata","2024-07-03"],["Y-m-d",1735689600,"Asia/Kolkata","2025-01-01"],["D, d M Y",1700000000,"America/New_York","Tue, 14 Nov 2023"],["D, d M Y",1720000000,"America/New_York","Wed, 03 Jul 2024"],["D, d M Y",1735689600,"America/New_York","Tue, 31 Dec 2024"],["D, d M Y",1700000000,"UTC","Tue, 14 Nov 2023"],["D, d M Y",1720000000,"UTC","Wed, 03 Jul 2024"],["D, d M Y",1735689600,"UTC","Wed, 01 Jan 2025"],["D, d M Y",1700000000,"Europe/London","Tue, 14 Nov 2023"],["D, d M Y",1720000000,"Europe/London","Wed, 03 Jul 2024"],["D, d M Y",1735689600,"Europe/London","Wed, 01 Jan 2025"],["D, d M Y",1700000000,"Asia/Kolkata","Wed, 15 Nov 2023"],["D, d M Y",1720000000,"Asia/Kolkata","Wed, 03 Jul 2024"],["D, d M Y",1735689600,"Asia/Kolkata","Wed, 01 Jan 2025"],["l jS \\o\\f F Y",1700000000,"America/New_York","Tuesday 14th of November 2023"],["l jS \\o\\f F Y",1720000000,"America/New_York","Wednesday 3rd of July 2024"],["l jS \\o\\f F Y",1735689600,"America/New_York","Tuesday 31st of December 2024"],["l jS \\o\\f F Y",1700000000,"UTC","Tuesday 14th of November 2023"],["l jS \\o\\f F Y",1720000000,"UTC","Wednesday 3rd of July 2024"],["l jS \\o\\f F Y",1735689600,"UTC","Wednesday 1st of January 2025"],["l jS \\o\\f F Y",1700000000,"Europe/London","Tuesday 14th of November 2023"],["l jS \\o\\f F Y",1720000000,"Europe/London","Wednesday 3rd of July 2024"],["l jS \\o\\f F Y",1735689600,"Europe/London","Wednesday 1st of January 2025"],["l jS \\o\\f F Y",1700000000,"Asia/Kolkata","Wednesday 15th of November 2023"],["l jS \\o\\f F Y",1720000000,"Asia/Kolkata","Wednesday 3rd of July 2024"],["l jS \\o\\f F Y",1735689600,"Asia/Kolkata","Wednesday 1st of January 2025"],["N w z W t L o",1700000000,"America/New_York","2 2 317 46 30 0 2023"],["N w z W t L o",1720000000,"America/New_York","3 3 184 27 31 1 2024"],["N w z W t L o",1735689600,"America/New_York","2 2 365 01 31 1 2025"],["N w z W t L o",1700000000,"UTC","2 2 317 46 30 0 2023"],["N w z W t L o",1720000000,"UTC","3 3 184 27 31 1 2024"],["N w z W t L o",1735689600,"UTC","3 3 0 01 31 0 2025"],["N w z W t L o",1700000000,"Europe/London","2 2 317 46 30 0 2023"],["N w z W t L o",1720000000,"Europe/London","3 3 184 27 31 1 2024"],["N w z W t L o",1735689600,"Europe/London","3 3 0 01 31 0 2025"],["N w z W t L o",1700000000,"Asia/Kolkata","3 3 318 46 30 0 2023"],["N w z W t L o",1720000000,"Asia/Kolkata","3 3 184 27 31 1 2024"],["N w z W t L o",1735689600,"Asia/Kolkata","3 3 0 01 31 0 2025"],["A h G",1700000000,"America/New_York","PM 05 17"],["A h G",1720000000,"America/New_York","AM 05 5"],["A h G",1735689600,"America/New_York","PM 07 19"],["A h G",1700000000,"UTC","PM 10 22"],["A h G",1720000000,"UTC","AM 09 9"],["A h G",1735689600,"UTC","AM 12 0"],["A h G",1700000000,"Europe/London","PM 10 22"],["A h G",1720000000,"Europe/London","AM 10 10"],["A h G",1735689600,"Europe/London","AM 12 0"],["A h G",1700000000,"Asia/Kolkata","AM 03 3"],["A h G",1720000000,"Asia/Kolkata","PM 03 15"],["A h G",1735689600,"Asia/Kolkata","AM 05 5"],["c",1700000000,"America/New_York","2023-11-14T17:13:20-05:00"],["c",1720000000,"America/New_York","2024-07-03T05:46:40-04:00"],["c",1735689600,"America/New_York","2024-12-31T19:00:00-05:00"],["c",1700000000,"UTC","2023-11-14T22:13:20+00:00"],["c",1720000000,"UTC","2024-07-03T09:46:40+00:00"],["c",1735689600,"UTC","2025-01-01T00:00:00+00:00"],["c",1700000000,"Europe/London","2023-11-14T22:13:20+00:00"],["c",1720000000,"Europe/London","2024-07-03T10:46:40+01:00"],["c",1735689600,"Europe/London","2025-01-01T00:00:00+00:00"],["c",1700000000,"Asia/Kolkata","2023-11-15T03:43:20+05:30"],["c",1720000000,"Asia/Kolkata","2024-07-03T15:16:40+05:30"],["c",1735689600,"Asia/Kolkata","2025-01-01T05:30:00+05:30"],["r",1700000000,"America/New_York","Tue, 14 Nov 2023 17:13:20 -0500"],["r",1720000000,"America/New_York","Wed, 03 Jul 2024 05:46:40 -0400"],["r",1735689600,"America/New_York","Tue, 31 Dec 2024 19:00:00 -0500"],["r",1700000000,"UTC","Tue, 14 Nov 2023 22:13:20 +0000"],["r",1720000000,"UTC","Wed, 03 Jul 2024 09:46:40 +0000"],["r",1735689600,"UTC","Wed, 01 Jan 2025 00:00:00 +0000"],["r",1700000000,"Europe/London","Tue, 14 Nov 2023 22:13:20 +0000"],["r",1720000000,"Europe/London","Wed, 03 Jul 2024 10:46:40 +0100"],["r",1735689600,"Europe/London","Wed, 01 Jan 2025 00:00:00 +0000"],["r",1700000000,"Asia/Kolkata","Wed, 15 Nov 2023 03:43:20 +0530"],["r",1720000000,"Asia/Kolkata","Wed, 03 Jul 2024 15:16:40 +0530"],["r",1735689600,"Asia/Kolkata","Wed, 01 Jan 2025 05:30:00 +0530"],["U",1700000000,"America/New_York","1700000000"],["U",1720000000,"America/New_York","1720000000"],["U",1735689600,"America/New_York","1735689600"],["U",1700000000,"UTC","1700000000"],["U",1720000000,"UTC","1720000000"],["U",1735689600,"UTC","1735689600"],["U",1700000000,"Europe/London","1700000000"],["U",1720000000,"Europe/London","1720000000"],["U",1735689600,"Europe/London","1735689600"],["U",1700000000,"Asia/Kolkata","1700000000"],["U",1720000000,"Asia/Kolkata","1720000000"],["U",1735689600,"Asia/Kolkata","1735689600"],["O P",1700000000,"America/New_York","-0500 -05:00"],["O P",1720000000,"America/New_York","-0400 -04:00"],["O P",1735689600,"America/New_York","-0500 -05:00"],["O P",1700000000,"UTC","+0000 +00:00"],["O P",1720000000,"UTC","+0000 +00:00"],["O P",1735689600,"UTC","+0000 +00:00"],["O P",1700000000,"Europe/London","+0000 +00:00"],["O P",1720000000,"Europe/London","+0100 +01:00"],["O P",1735689600,"Europe/London","+0000 +00:00"],["O P",1700000000,"Asia/Kolkata","+0530 +05:30"],["O P",1720000000,"Asia/Kolkata","+0530 +05:30"],["O P",1735689600,"Asia/Kolkata","+0530 +05:30"],["jS",1700000000,"America/New_York","14th"],["jS",1720000000,"America/New_York","3rd"],["jS",1735689600,"America/New_York","31st"],["jS",1700000000,"UTC","14th"],["jS",1720000000,"UTC","3rd"],["jS",1735689600,"UTC","1st"],["jS",1700000000,"Europe/London","14th"],["jS",1720000000,"Europe/London","3rd"],["jS",1735689600,"Europe/London","1st"],["jS",1700000000,"Asia/Kolkata","15th"],["jS",1720000000,"Asia/Kolkata","3rd"],["jS",1735689600,"Asia/Kolkata","1st"],["S",1700000000,"America/New_York","th"],["S",1720000000,"America/New_York","rd"],["S",1735689600,"America/New_York","st"],["S",1700000000,"UTC","th"],["S",1720000000,"UTC","rd"],["S",1735689600,"UTC","st"],["S",1700000000,"Europe/London","th"],["S",1720000000,"Europe/London","rd"],["S",1735689600,"Europe/London","st"],["S",1700000000,"Asia/Kolkata","th"],["S",1720000000,"Asia/Kolkata","rd"],["S",1735689600,"Asia/Kolkata","st"]]},"replacer":[["%title% %sep% %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello - Site"],["%title% %sep% %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," | Site & Co"],["%title% %sep% %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B -Site-"],["%title% %sep% %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> &raquo; S &amp; S"],["%title% %sep%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello "],["%title% %sep%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," "],["%title% %sep%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B "],["%title% %sep%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> "],["%sep% %title%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"- Hello"],["%sep% %title%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"| "],["%sep% %title%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"- A - B"],["%sep% %title%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"&raquo; <i>tag</i>"],["%title%%sep%%sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},""],["%title%%sep%%sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},""],["%title%%sep%%sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},""],["%title%%sep%%sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},""],["%title% %sep% %sep% %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello - Site"],["%title% %sep% %sep% %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," | Site & Co"],["%title% %sep% %sep% %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B -Site-"],["%title% %sep% %sep% %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> &raquo; S &amp; S"],["%title% - - %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello - - Site"],["%title% - - %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," - - Site & Co"],["%title% - - %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B - - -Site-"],["%title% - - %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> - - S &amp; S"],["plain text",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"plain text"],["plain text",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"plain text"],["plain text",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"plain text"],["plain text",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"plain text"],["100% sure",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"100% sure"],["100% sure",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"100% sure"],["100% sure",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"100% sure"],["100% sure",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"100% sure"],["%%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"%%"],["%%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"%%"],["%%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"%%"],["%%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"%%"],["%title",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"%title"],["%title",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"%title"],["%title",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"%title"],["%title",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"%title"],["a %unknown% b",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"a b"],["a %unknown% b",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"a b"],["a %unknown% b",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"a b"],["a %unknown% b",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"a b"],["%Title% %SITENAME%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""}," "],["%Title% %SITENAME%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," "],["%Title% %SITENAME%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""}," "],["%Title% %SITENAME%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""}," "],["<b>%title%</b> <i>x</i>",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello x"],["<b>%title%</b> <i>x</i>",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," x"],["<b>%title%</b> <i>x</i>",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B x"],["<b>%title%</b> <i>x</i>",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> x"],["%title%\n%sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello\nSite"],["%title%\n%sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"\nSite & Co"],["%title%\n%sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B\n-Site-"],["%title%\n%sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i>\nS &amp; S"],["%title%   %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello Site"],["%title%   %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," Site & Co"],["%title%   %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B -Site-"],["%title%   %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> S &amp; S"],["%xarg(F j, Y)% done",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"[F j, Y] done"],["%xarg(F j, Y)% done",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"[F j, Y] done"],["%xarg(F j, Y)% done",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"[F j, Y] done"],["%xarg(F j, Y)% done",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"[F j, Y] done"],["%xarg()% e",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""}," e"],["%xarg()% e",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," e"],["%xarg()% e",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""}," e"],["%xarg()% e",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""}," e"],["%term% Archives %page% %sep% %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Term Archives - Site"],["%term% Archives %page% %sep% %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," Archives Page 2 of 4 | Site & Co"],["%term% Archives %page% %sep% %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"T Archives - Page 2 -Site-"],["%term% Archives %page% %sep% %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""}," Archives &raquo; S &amp; S"],["%page%%sep%%title%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},""],["%page%%sep%%title%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},""],["%page%%sep%%title%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},""],["%page%%sep%%title%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},""],["%sitename% %page% %sep% %sitedesc%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Site - Tagline"],["%sitename% %page% %sep% %sitedesc%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"Site & Co Page 2 of 4 | "],["%sitename% %page% %sep% %sitedesc%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"-Site- Page 2 - x"],["%sitename% %page% %sep% %sitedesc%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"S &amp; S &raquo; "],["%name%, Contributor to %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Ann, Contributor to Site"],["%name%, Contributor to %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},", Contributor to Site & Co"],["%name%, Contributor to %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"n, Contributor to -Site-"],["%name%, Contributor to %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},", Contributor to S &amp; S"],["%sep%%sep%%sep%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},""],["%sep%%sep%%sep%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},""],["%sep%%sep%%sep%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},""],["%sep%%sep%%sep%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},""],["a%sep%b%sep%c",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"ac"],["a%sep%b%sep%c",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""},"ac"],["a%sep%b%sep%c",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"ac"],["a%sep%b%sep%c",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"ac"],["%title% &amp; %sitename%",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""},"Hello &amp; Site"],["%title% &amp; %sitename%",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," &amp; Site & Co"],["%title% &amp; %sitename%",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""},"A - B &amp; -Site-"],["%title% &amp; %sitename%",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""},"<i>tag</i> &amp; S &amp; S"],["%empty% x",{"title":"Hello","sep":"-","sitename":"Site","sitedesc":"Tagline","page":"","term":"Term","excerpt":"An excerpt","name":"Ann","empty":""}," x"],["%empty% x",{"title":"","sep":"|","sitename":"Site & Co","sitedesc":"","page":"Page 2 of 4","term":"","excerpt":"","name":"","empty":""}," x"],["%empty% x",{"title":"A - B","sep":"-","sitename":"-Site-","sitedesc":"x","page":"- Page 2","term":"T","excerpt":"e","name":"n","empty":""}," x"],["%empty% x",{"title":"<i>tag</i>","sep":"&raquo;","sitename":"S &amp; S","sitedesc":"","page":"","term":"","excerpt":"","name":"","empty":""}," x"]],"live":{"fineline":{"table":{"what-you-need-to-know-about-metal-roof-painting":"1e8eb4e94e3329e0b04452f61b377fd7","7-common-questions-about-professional-painters":"3344db86206a2bf1cb27b50c83c5a101","how-to-stain-a-log-cabin-with-chinking":"b934bdffd70a62a47cfb12abb2c8b8b7","guide-to-the-wonders-of-spraying-doors":"e57591a6c725f74decff74053a0fc3ae","how-often-to-stain-a-log-home-10-things-you-need-to-know":"a6797e9b595c5f38d372580cc3fa627b","5-steps-to-staining-a-log-cabin":"9f80c2911edc25362bc2ec2eaea1e475","choosing-the-best-log-home-stain":"5721f8e7b479beecc9b185c022ad8f94","blog":"8ebf37532d0ba31d90744054bf05f140","why-are-barns-painted-red":"161b2d13f2d0002bdfc8c63bed08a979","/":"9fc396815a7cf33e1fde234b7f121e56","the-benefits-of-premium-paint":"811a81000dc0e014841e6eb7db45ebb6","about-us":"40909ecf9081cfea78a0e40ff463d9fc","contact-us":"2d4daf4b6bdffd7c0a9beea6e7183524","service/hardwood-floor-refinishing":"d1f9e006b684ac6d68dd5f8a9adaed5d","privacy-policy":"f44880e3521e3c4ed67e8eb81b1bc7b3","financing":"ac21744fdc86867a778575f99286d14e","premium-paint":"a8ff83bc85b929efeaae9f30113fe8b6","quote":"ff26b67c675944344b445a8917c2e2f6","commercial":"45091134dd52bd7efb6af746f7500f2e","residential":"ce9f4a8dd801cbcb30f5d0b1c24fc5e9","projects":"34508cb64792ca3422f411e5df9685f6","project/interior-paint-job-in-lebanon-pa-2":"c51c21d4881737e351c07df69616ab45","project/log-home-staining-in-bethel-pa":"61a3ea07fc217d6281a8dd09b97e701b","project/painting-historic-house-in-kleinfeltersville-pa":"8cb2533a4d10fd458593d666b6b6ebda","project/interior-kitchen-paint-job-myerstown-pa":"5c8f1879504ea604405114a44889d5ce","project/interior-kitchen-painting-job-in-bethel-pa":"0ff3ab7051a9607b22e61eccaedb51ca","project/interior-kitchen-paint-job-in-grantville-pa":"a49470b07bb64f5f738bbfe3c5e17a70","project/interior-paint-job-myerstown-pa":"e7908d88e297fe83b9d572f8053cdba8","project/interior-kitchen-painting-in-newmanstown":"a8f93e47f881bbd0b7c41d695af288ab","project/interior-kitchen-paint-job-in-myerstown-pa":"07d1f94172436bf9257e853f0680f898","project/interior-kitchen-paint-job-in-fredericksburg-pa":"72536c5b68bd29603eb757248efe0a76","project/interior-paint-job-in-richland-pa":"69a28820fa07e7f11771eb67e0d3deea","project/interior-paint-job-in-lebanon-pa":"b3757ed90e9e58c4097aa87133de64f7","project/interior-paint-job-in-myerstown-pa":"47baa269e2e9f097a8c99d8c1499a5fa","project/exterior-paint-job-in-myerstown-pa":"6677adf3157d710389620b6946232ba3","project/exterior-fence-paint-project-in-lebanon":"37eb199e6244508d92cf867491600001","project/barn-painting-in-lebanon":"1075c6c436ec311a7e5fb2ef3bbb442e","project/log-cabin-staining-in-albrightsville-pa":"397edc96d9c678aef5c4b9f0fc85b503","project/log-home-staining-in-boyertown":"a8649a81947158ee62165f6624ad675e","project/barn-painting-in-annville-pa":"86ff39f50f7579125fb74764dd58d18d","project/log-home-staining-in-new-providence-pa":"4a9da1a7806670300241f7729b52fc93","project/interior-commercial-paint-job-in-jonestown-pa":"3abaaa6eeb11bf3edcdf417592475498","project/log-cabin-staining-in-fredericksburg-pa":"74252f0ffcd86ea07b12f36acc112155","project/interior-painting-for-new-construction-in-potter-county":"4f9627e07f3ec562f6ebe3477d47c412","project/house-painting-in-pine-grove-pa":"97bc0672b441143b124682d106ef7289","project/log-home-staining-in-springville-pa":"543104a264a975b4c3d988c3e5016290","project/painting-newly-built-house-in-lebanon-pa":"c9dfaca3be5e9dfd0349d51acef5a709","project/house-painting-in-malvern-pa":"688a07932b79781b76993d17ecc967cf","project/staining-the-elizabeth-township-pavilion":"1d35784733a9036c9c22642d58555ef7","project/roof-recoating-in-schaefferstown-pa-2":"2ef5cd75f2383152dad2463e1dbc34be","project/jonestown-project-with-wallpaper":"e2e88a9831e4d7d53546baad3e33ba34","project/gazebo-ceiling-stained-project":"8588605f887d05d3a71315ffa8fc0d54","project/garage-cracked-walls":"04a0f10d7649b12d2ece780097a9c717","project/floor-refinishing-project":"78c844d82ec9071970e49efe98e054ad","project/shutter-painting-project":"2dc23e4c11541679c0514d6dfa7712cb","project/whole-house-painting-in-myerstown-pa":"01267467edcac45626c1eb9cb01e21de","project/interior-home-painting-in-lebanon-pa":"a673a31a7a6e2a28e7acca83a8b4c43b","project/walls-and-trim-painting-in-grantville-pa":"a088278ef75b6f327ce7338ae3896af7","project/chicken-house-painting-in-watsontown-pa":"acbe1b5bc214f11f971e25fde8158bd7","project/log-cabin-stained-in-denver-pa":"e83bef87291578e54a3c5f45954ad772","project/log-cabin-staining-in-mertztown-pa":"742afb77cf0d7895cfd5b68560e96b28","project/wooden-barn-painting-in-conestoga-pa":"5983e463dfa6163e5bf045a202e37d39","project/painted-walls-ceiling-in-lebanon-pa":"d30c668f95d63cadb0fdfcbd91185569","project/exterior-stucco-foundation-painting-in-lebanon-pa":"fb620534c54300e5d707053a0fb43a8b","project/interior-stain-and-paint-project-in-richland-pa":"b98675effb31002aad954e31bb0f73a1","project/exterior-brick-and-metal-commercial-painting-in-richland-pa":"650302baa9e37f9de83c10b99454ca49","project/interior-painting-in-hamburg-pa":"121e5c9938f30967c56211a3be263b35","project/hardwood-floor-refinishing-in-lebanon-pa":"2616ac7f29be2097b7d58b33f2c7efa5","project/interior-paint":"5e4b40eb8bf87cbb7860326580852056","project/barn-roof-painting-lebanon-pa":"e80f2ff4d10ad80ff56825816026579f","project/painted-kitchen-cabinets-in-myerstown":"da277b679d2e1a162655c4ab66e61060","project/paint-and-stain":"abfedba34705eaa73a4757ad3e637e6e","project/log-cabin-staining-myerstown":"10dd29eb909d45f68b8df3eef631cb20","project/painted-historic-mansion-in-reading-pa":"2b33b27526f961902a5d377465a6854f","project/cabin-staining-in-finksburg-pa":"260e0e91a01c9dbd10cab5ef84bab484","project/wedding-venue-barn-staining-in-york-pa":"01a8fa30495e6af202c82594e2028d3c","project/line-painting-and-floor-resurfacing-in-myerstown-pa":"09b26711a14f1499258f65394008422a","project/commercial-painting-project-in-morgantown-pa":"946526296b10942aefbe828ea699fdae","project/hardwood-floor-refinishing-in-lebanon-pa-2":"c808988dfd369743c71a7d159ef62f3f","project/commercial-exterior-paint-job-in-downtown-lebanon-city":"7a316077897479a7dba0936590dc4592","project/whole-house-interior-painting-in-schuylkill-haven-pa":"608c320cecaa0dc679dc009b89be4a39","project/log-cabin-staining-and-painting-in-shunk-pa":"231d41e282c09055ae749caed5ff2b95","project/log-cabin-staining-in-jim-thorpe":"54b7a2b7d6bf32166dbeef6b59739548","project/exterior-barn-painting-in-york":"5d9e2fdbae487b97e63a0e3d088bae79","project/red-barn-painting-project-in-dallas-pa":"532189d7149eb2bf5756129f5aa4a633","project/log-cabin-staining-in-brandywine-pa":"dc2d6f5e3766e588ea1563ee34e1f819","project/barn-painting-in-manheim-pa":"29c3d4ce3e3db411c131221e467c9a05","project/log-cabin-staining-in-mohnton-pa":"20721e3e48bbf672d531e45f2cb26c39","project/log-cabin-staining-in-dover-pa":"26b71d1cebcb26c6432b0405bd0e92e5","project/exterior-and-interior-painting-in-fredericksburg-pa":"ff1d29371307d6367ce0285829553fad","project/log-home-staining-in-wernersville-pa":"822a9780fe25ce58ce10e3583fd7ab0d","project/log-cabin-staining-and-painting-in-waynesboro":"358aec25cc705baa5bfcf9d5513ad1f6","project/board-and-batten-staining-in-new-providence":"246491c532157920128888340a80bf4f","project/log-home-staining-in-ephrata-pa":"ac7f87277d131ca5c53d05d03c13dab5","project/repaint-and-drywall-job-in-lebanon-pa":"8eea8e0cfa3996c2fc8deb3ad31e8d03","project/bathroom-painting-in-reinholds":"7e9bfc958c3b8f1b58cfc32948ad7e77","project/log-cabin-staining-in-east-berlin":"2b512d9328f494157b3af0a90e840569","project/log-cabin-staining-in-conestoga-pa":"d1cc640dff07d06f295c52bd4f6bb82c","project/exterior-stain-job-in-lebanon-pa":"82ed7182ef48557e74ab75840a573b58","project/log-cabin-staining-in-havre-de-grace-md":"67f3037f8309eb9c942f3ab805405f15","project/log-cabin-staining-in-shartelsville-pa":"0144b80e8a27013d5b750744e8cf70e0","project/log-cabin-staining-in-glen-rock-pa":"76ac3bdfa7f0acab3a1d9619cf4a4bc5","project/interior-walls-painted-in-bethel-pa":"0b119ff6af6e2cefa68aae39322d8047","service/exterior-painting":"29fc40ac4ecf841505b4c0b76d137fb2","service/kitchen-cabinet-painters":"4a154b7351604265c2e72f8ea277fd85","service/kitchens":"ce15bc61ec07f04ea62065ade83388c4","service/metal-roof-painting":"4eaa8359c37f8916104e09623e83b9c3","services":"54abbf1057ec3fbf19d0abf0ae375f1f","service/shutter-painting":"4314cbc64a7023389f00f539f7993417","service/vinyl-painting":"e7c86b6522f20ad23d55cb762bd2ee4d","service/trim":"c8ac7a28cf31c814d5f13a98aa224a11","service/wood-siding":"7e5780a296d406ddd6da6b9bb80b7f88","service/doors":"5ca1ba8ea179b2964ffdc28855717959","service/barn-painting":"6d2d02903599dd613d772e6182b560dc","service/brick-painting":"0a64b0cb5b3837249b71b37426550411","service/municipal-painting":"7945a8b67307b455efecff19d7fe0a12","service/stucco-painting":"cb9dfb90bb9714555d90b2ef3108a734","service/log-homes":"4b1512325914aced355cdb732366c8a4","service/interior-painting":"fc84f98adb8762a4157017ac2485cab2","service/line-painting":"82e32bc68b69f64ed54dc9c92423f5d1","service/bathrooms":"c5f886f7c385a89c1320d30ef8a8fee0","category/blog":"8ebf37532d0ba31d90744054bf05f140","service/barn-roof-painting":"88d7d38b8ec988138f330835c4c6f0ae","service_area/pennsylvania":"387d433552a68f14be80d687c2924c21","service_area/potter-county-pa":"394493cb6e10025b3550b5f35623c168","service_area/chester-county-pa":"9201236eb67794a6eef3b14d7aaaa3a4","service_area/susquehanna-county-pa":"81ef2cd5a548c887f399bd311d201a2a","service_area/schuylkill-county-pa":"43839ef38e961f5be1eff87ef8da447a","service_area/lancaster-county-pa":"e3b8582a76dd74b0c8304a28cf6bf2e0","service_area/northumberland-county":"922eac7286b45db8d19c7a91766e9ea3","service_area/lebanon-county-pa":"a7a23b574eaeeaa502b00b858fe0e7ba","service_area/berks-county-pa":"49addfbf258aafba12f8819b9b1b4f73","service_area/dauphin-county-pa":"28814b60a8bed322b3ec7d18eebce6fb","service_area/york-county-pa":"c7621f0dfee71a40c950b37f3a48e47b","service_area/adams-county-pa":"21e144029f9daca94bc64ecbc8a7bc9d","service_area/luzerne-county-pa":"b4f74f2914ac600252577e8ecbaf1419","service_area/maryland":"477d144f3605f24c1950a637ee9798dd","service_area/carbon-county-pa":"393f329458f7cf247b6d75e015a71f7f","service_area/sullivan-county-pa":"ec7b73e320a0b5fa77d0fb620cb0680c","service_area/franklin-county":"4af858a37d138ccb2caeb2df87081749"},"different":{"service_area/adams-county-pa":{"live":["Professional Painters in Adams, PA | Fine Line Painting","ith over four decades of experience, our professional painters in Adams, PA ensure that every paint job is flawless and customizable.","follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large",""],"ours":["Professional Painters in Adams, PA | Fine Line Painting","ith over four decades of experience, our professional painters in Adams, PA ensure that every paint job is flawless and customizable.","follow, noindex",""]}}},"ap":{"table":{"essays/peter-eby-the-great-swiss-american-anabaptist-elder-of-pequea":"df1c4bb27057d215dbed3592174def28","essays/practical-crucifixion-notes-on-spiritual-formation":"22d2ca320afc483dbce889c06c0e263b","essays/all-christians-speak-in-church-what-does-this-mean-for-sisters":"267f853c222df31e651259ff16ce0dcd","essays/how-can-anabaptism-fulfill-its-destiny-to-become-just-plain-christianity":"2a5f580ca2e1d205ef3f9e18fb1ad5c2","essays/a-silent-night-amid-the-killing":"fc2a149b8b161280b1e549268a75c4d4","essays":"4b0db2bc897932a9d71fe7b5bc1421bb","essays/the-strange-death-of-hidden-life":"74fe3a1e7466c8e3ce1036211d6d6fc7","essays/kingdom-reductionism":"65ae38692961d9b67da2c6c961c0fbed","essays/money-education-and-my-anabaptist-experience":"693abc9d7b8c1426341cb552bc85faf7","essays/how-passionate-25-year-olds-become-fruitful-45-year-olds":"04354798765dee90e81514ddbd58ad72","essays/sharing-plans-cannot-replace-brotherly-aid":"7ae525e919ff8c33263efb5e4d127290","essays/gods-pursuit-of-affectionate-relationship":"5ce3a65af8d02a4d11dd984b3ccc9827","essays/revisiting-the-lords-table-again-and-again":"4dc213ce40b1ac953743941655482ff8","essays/a-matter-of-power":"98d0ade1fc81300cac702f7626088201","essays/who-is-my-neighbor":"d241710f75a0aef5e46d9cc75b6e1ed7","essays/the-lords-supper-as-fellowship":"41b59f0f7e3a5b4da26d1925073dcd3b","essays/my-ethics-your-ethics-and-the-dilemma-between":"bf2c1e90e4669b77ca809a03d27296f7","essays/the-cultural-captivity-of-the-gospel":"f3d232f484904ac68aa65f36cbdb2a20","essays/god-is-not-mocked":"df44ca495a46c278cd17495649fd45b7","essays/the-way-we-live-is-the-way-we-educate":"3f305023bda983a3bbf614a076d2855f","essays/business-as-stewardship":"d848a39894b714991762e83b0bface02","essays/entrepreneurs-as-servant-managers":"aafa368ffb2ade5bc11a937ed24a306c","essays/from-every-nation-tribe-and-language":"32c3a40f2fae65bccb4881834f3c073a","essays/men-are-going-to-hell-why-bother-with-humanitarian-aid":"a5435bbfaf222310ee2fa61c47aa0f57","essays/learning-from-our-neighbors":"a9bd9212311166aeb307ecfe0e28dd0c","essays/schism-is-heresy":"026ad728558908110b047d2bdeabc494","essays/investing-is-not-gambling-speculating-might-be":"e5103273d3aed97148df61cd7d40c6d4","essays/but-you-will-just-die":"8b245e5062746d07a43c39934e8b164c","essays/keeshons-story-a-knock-heard-round-the-hood-part-4":"7bb0b3778c8ac8dc49174c3951003b18","essays/graduate-four-colleges":"94e904b79228d38ef4e2d296f907a76e","essays/a-handful-of-hard-notes":"dc17cfa724dd96f0bc1eac4a3cdd093e","essays/keeshons-story-a-knock-heard-round-the-hood-part-3":"862167c41dd73d3d04eadaa51df2525c","essays/keeshons-story-a-knock-heard-round-the-hood-part-2":"c65cd753611909946ffc85384322b6a6","essays/keeshons-story-a-knock-heard-round-the-hood-part-1":"b0e9e32ae1229dfe535bba26f70ef681","essays/husbands-wives-and-the-arsenal-of-jesus-sacrificial-kingdom":"68c50a64360d9be82e7891817cc310bc","essays/faith-works-and-assurance":"0044b9c1de035bb898ac976f8f441e32","essays/from-condemned-slave-to-belonging-child":"77924678128106a456b2f714d3658d73","essays/when-good-men-do-nothing":"a27c7cfe79d3c2f4cc5ea00ddd9fa85d","essays/what-is-jesus-sacrificial-kingdom":"afacaf2b5f9df909c80013885e48473a","essays/how-should-we-live":"adec5a7f9ef002eef29b70f86b13ecbc","essays/managers-in-gods-household":"2846a99c9749d054f0a5e98087039267","essays/religious-dualism":"f94ec1ed2c16034054caf15939180c61","essays/why-anabaptists-dont-have-priests":"1fd5b68c70949b52845e8286b7253b60","essays/studying-the-word-of-god":"34516abf3b6cef8f7ac7200f44b11e92","essays/choosing-translations-for-bible-study":"b4b3823969f6c7641c35a21436db0528","essays/advantages-anabaptist-culture-missions":"c86c8b57a63d1e5c038cc37409c22ac9","essays/end-muslims-response-jerry-falwell-jr":"4f2b85138d1d325d302b7cbe8b0c78e2","essays/local-church-evangelism":"be06acb12b4384fcb5c89f23a694b331","essays/i-started-an-anabaptist-womens-magazine":"129ba07045fd2738cc5def196a53ec34","essays/the-new-conservatives":"30229feb71c91351ed1d3b7772570eb6","essays/forgiveness-is-not-putting-up-with":"cc2c5506a5705fbb4e69805918a1f387","essays/rebirth-and-the-law-of-sowing-and-reaping":"096902e911a2a4081236729fd68106e7","essays/noun-doctrines-and-verb-doctrines":"bc199fceb12555f225923af88e0ea69f","essays/cultivating-creativity-in-gods-kingdom":"5274c1cacd411fc7c77231a28e7f6362","essays/why-work-work-as-knowing":"284b09b17c7c086c4745409ab79b4c8e","essays/teaching-children-to-relate-to-children-from-other-cultures":"d4f60b4e288cc897150d96e456bc6c40","essays/a-glimpse-at-anti-semitism":"5689075f6169b4960063a781d66e515f","essays/suffering-love-is-the-engine-of-the-kingdom-of-god":"8336698a143c1b6fa6b211b10fc393a3","essays/anabaptists-on-the-internet-reflecting-on-conversations-about-my-faith":"7ff8b10f753e1a183b214870af84e51b","essays/why-new-bible-translations-matter-an-example":"0b2aed832456963d3b543e4624342479","essays/a-crisis-wasted":"2595c43f77517339d53f6a4ebb7f1a24","essays/grace-and-truth-vs-grace-or-truth":"3771b9a9341b9232c3e29a20a94a7015","essays/walk-in-the-unity-jesus-created":"2425ce071cc060ecd62d8a1c7d8a155a","essays/directing-gods-resources-as-a-homemaker":"21bad2a2181f84358988828889cc1463","essays/covid19-restrictions-and-christian-brotherhood":"cd98a677a3e180eebb60a72e3baae750","essays/part-2-mennonites-during-the-revolutionary-civil-wars":"775b41f8da89594a84944ec12cb83d69","essays/part-1-why-did-the-german-mennonites-become-nazis":"2165688220ce69885f7793dcbec34e23","essays/nationalism-and-christianity":"ab7124d428fb17e4e1b39e90b1555d73","essays/seeking-better-vision":"8cc046df361d691c5f0dadde2dd62762","essays/what-we-learn-from-new-testament-advice-to-slaves":"41aa61ed88cae925f5ced03e22a038ef","essays/hebrew-bible-history-part-1":"c239f4d61c280ee85d8cffca167db9f9","essays/hebrew-bible-history-part-2":"d9d3cdd39effa84aca0ca01d2e9a44a2","essays/hebrew-bible-history-part-3-vince-beiler":"e1a0cb6b42528bd39224a194739c6e81","essays/what-is-sexual-abuse-part-1":"52e57c4898979891b243c3c5354f328b","essays/jesus-means-what-he-says":"4b61008b194c6baf125a1c83952c6315","essays/what-is-knowledge":"2c704e51fda211badd16fc196228d6dc","essays/the-importance-of-christs-death-and-resurrection":"9cc455ee682c3c9d9a80d0a6c5b6a5e3","essays/cremation-versus-burial":"0645598e149bdac0701adb3b26baa712","essays/thank-you-god-for-answered-prayer-relaunching-the-blog":"bcdf37a21731b1a8e98c8eda09fa584f","essays/guest-blog-poverty-wealth":"502f1af7a2bd726915be4b84bd7f81c5","essays/the-geography-of-loneliness":"d51bca7d85ca744ee72caa896fe7d38e","essays/friend-died-remembering-john-chau":"b3bcaed5ea99e9513149de50ff57deae","essays/guest-blog-schools-common-good":"2ec3572496671f80bea9f1b723fe4de4","essays/powerful-witness-sex-attracted-christians":"d044c3d6502138dc6cc8498d30727299","essays/a-covid-19-economy-and-stewardship":"9b5df43c0182bbbccf6fc5c88f196513","essays/a-look-at-romans-12-and-13":"86f0c0712af158e6a32f2e18a001fd90","essays/recovery-and-healing-resources-for-sexual-abuse-part-2":"84771cf780ff78a477920475e437d93a","essays/the-expression-of-music":"031f316e12b163ccaea1e1157841b765","essays/money-modesty-body-modesty":"849eceb74dac180f6647a55cf2afb393","essays/integrity-the-allure-of-doubleness":"1d92d56e6d1ef507be60ca658ac44051","essays/the-inside-out-sandwich":"246a675202b9195492c730a3c97a3f5e","essays/following-jesus-into-the-bible":"e49258eba79918c9776e0c44b574ef43","essays/crafting-christlike-friendships-with-internationals":"76d8d80d2f467ecfb4b5bcc0b1696351","essays/the-power-question-gelassenheit-and-koinonia":"30c9f6939ed20a26e534ed233d4a4d19","essays/good-deeds-and-bad-hearts":"c07bc8386bd545ed690aa5562d5a87b0","essays/planting-an-anabaptist-church-in-a-city":"6e33909dfc9cea2dcce3061de5f8a61e","essays/anti-abortion-or-pro-lives-a-call-to-redemptive-engagement-with-the-abortion-crisis":"4d790c4e782ca2a1b8ecf2498919262f","/":"795870c602a45b4f14883315faf562a3","essays/following-homeless-lord":"1fc2990209f988bbef2c9aa1a35842f9","contact":"91c2ac6d50b3d3460596c4f5bf3c5800","about":"251a20990a85429bf4f722e683d4e712","donate":"3068d83c61ad7b2be4a8b1cd1b09a329","origins":"a0c000c046db6df61640c0c8ebd5b50f","follow":"5f12d41994fb7e696260a4e8c3d65cc5","follw2":"64ad3fc463ed3a06c7c2945fd6172d0c","episodes":"7a2231b29ae4508a189871b2c85277e4","donor-dashboard":"11fd9ec193ce313ca4d6dc8974c29524","4272-2":"88aa4e2a211e2edffbd01675787e61b3","about-2":"bd662461da4a2966e9f6a5b82def090b","episodes/what-happened-to-those-who-wouldnt-fight-in-world-war-1":"71590ff029eefcde10bb5da984361b69","episodes/do-we-need-the-church-fathers":"99ea76d1869e7c6d03fa9ac31ad65bbe","episodes/highlights-from-anabaptist-origins-pre-visit":"f6febf96344c5274bbcf905418efd498","episodes/what-is-the-most-accurate-church-what-if-my-family-disagrees":"a29c0f753c4c32280f3e0c8bd52b7c8c","episodelist":"192c28c7149a57fe87ffca8e270b4504","episodes/we-lost-all-faith-under-communism-the-sermon-on-the-mount-brought-me-back":"0e8ace2bf805a3fc4c64d83ba3539020","episodes/i-was-the-result-of-abuse-god-gave-me-purpose-and-helped-me-forgive-my-biological-dad":"5df892d60a4d5167cc0a3ab2831282b0","episodes/i-started-a-business-in-greece-to-help-refugees-begin-a-new-life":"aaded85a90d428b30682fe093fc6cae8","episodes/is-the-world-actually-getting-better":"a1020579dafb9dea5f5d5e26ec6b627e","episodes/did-god-authorize-america-to-wreak-vengeance-on-the-world":"138269d67815cd9fe31ad0eb8e48a3ce","episodes/anabaptists-and-the-sacraments-its-complicated":"478751cc3aae7e4435e3d60ac6f781fa","episodes/peter-called-lot-righteous-why-dont-we":"225fc1c47ac77c8ec5a8470077c4ab1b","episodes/why-the-anabaptist-origins-documentary-series":"1edffba5bd8f8d0dc806552ef95b195a","become-a-partner-monthly-contribution":"ff9da7e9b856c4a73de6d1420ebd8c7a","dev-episodes":"99565dbbeb8acd42315458fe22b93baa","dev-essays":"65e27f11788858219d1fd8e52aa4f650","episode-test-page":"01ccaacc246c71dd72d0aef9c090f45e","contact-dashboard":"f1c7785cef02424dd0cc0cf60febce59","thank-you":"541aaf888529b739febe2ea0f4617892","team":"ab13711adc44028ea53fc27079838850","updates":"f0cbd26b1dd3b44a9ce1e9b13f51977f","privacy":"fcf8429d1f82f54ef2858b7eeff2bea0","terms":"a7576568f3c4bde3cce144fd95942b7c","topics":"2a90502460471de0e1cf3b8b1ba87728","giving-tuesday":"b05c0ea5ec69d17058ba0d1c1414f41a","covid19-d94":"fa6f286e3adb4a6fbd0e17161ac3be01","slider-pagescall-to-discipleship":"5cb541019bb27d598998033d069dc5d6","supporters_update/encouraging-allegiance-supporters-update-26":"8120b803da8ce28ee5e76634d466d9bc","supporters_update/supporters-update-27":"6a4fd0629dc13590ad80073ff4a21aa5","supporters_update/three-years-in-supporters-update-15":"551949e38c41c8b7ea6d0edfb742b000","supporters_update/supporters-update-25":"1e09a2088e680abdbedfd73827239e2d","supporters_update/encouraging-supporters-update-24":"53539e318ef86dddd3a079a656a3a196","supporters_update/supporters-update-18":"47f48a08e34177af2ceb4677eced6398","supporters_update/excitement-and-opportunity-supporters-update-16":"a12e6c06b73a7a6a696cd6aa28e108dc","supporters_update/supporters-update-17":"d41b3f222a4e5535e594f3294141bb0f","supporters_update/supporters-update-19":"ac791d72a495a036a7ffaa6666eec41c","supporters_update/supporters-update-20":"5d7eca70098c8c0881aa04c04d1af958","supporters_update/supporters-update-21":"cb2c1b20683e5432d536d552836dbce6","supporters_update/supporters-update-23":"ae48c8052b603257a0e19451408fcddd","supporters_update/supporters-update-22":"34fbc774495c39b7e990edf60a6091b0","category/theology":"f56da0a147db362dd0a317c1303468ef","category/uncategorized":"94180bb01ada0a526ee7b6da1a588bdc","category/current-issues":"79b90cc45cbe81e6100a409d6c90684f","category/missions-evangelism":"14a3e3eab5f668a9dcead09a3eaa23b7","category/testimony-life-experience":"0d5b62e65dc6d8987b65220c271e6d97","category/christian-living":"871adaa6d21d23e0b833cdde2a13645b","category/study-education":"5e394bc09a856ebd597dafcb801dcfba","category/history":"75fe5934871076c4297a869ebb7a77e0","category/church":"9cdd9462b023b004c4d4d59a164432ba","category/ask-anabaptist-perspectives-anything":"c4c6538185df298f9b57736a5db6c0fe","category/economics":"a018d618b60ccdc4ec99cb3decd554f8","category/bible":"6001038ad3b00665e69981b25a39c35d","category/war":"e4eb722e7a4bdab83618e486a143ccf9","category/testimony-and-life-experience":"fc42024d90b65dd6f3aa4cf69b99a30c","tag/peace":"bcf6c8c87ffcb07123714e7e69318bb3","category/study-and-education":"b69c1b1b23d13ca13103cd2afa45baa2","tag/poverty":"3da0a37124db61c171fd938df2401186","tag/bible-text-and-translation":"45e83a79cdf0e1dde6b25e6350142d2c","tag/covid19":"0f8a2f590df7fe65b854bc324bd8886d","tag/business":"0403d3536db9e7b039e646e63b9bcfbf","tag/enemy-love":"a6fbd02396d64ebb80fb752979bfee50","tag/technology":"22f2b53dba4b06537dd54c9124668894","tag/nonresistance":"221241f38e7f03ef4b1afa13e0764b21","tag/testimony":"81648a9bd9e6d4aabf0bf95d4984edc4","tag/war":"e4eb722e7a4bdab83618e486a143ccf9","tag/heritage":"03982be314904dbf2ec6044e75a78f2d","tag/history":"75fe5934871076c4297a869ebb7a77e0","tag/greek":"6afe3d66a3cb5c6242e9d65e47aa8c99","tag/creation":"42a2702add3d0a7d11b85db5e883bde5","tag/salvation":"f22c3925d6a895ab3a1c2d7d5c00b7d7","tag/christians-and-government":"1718df6ffe699e4118a43d2caad07c74","tag/death":"5903bd9aeb2fff156a52230e5c3a06e7","tag/women-in-the-church":"5c7e6551d93d3417817c27eb5a2afb28","tag/debate":"0775f7b3d854d48b02edcd1d9700e8c1","tag/internet":"c757c5a57241877bd0b60db76d1355d9","tag/philosophy":"0daf9d4db35f4f851784c2b5a41d15a2","tag/sin":"c8a108f75f63b1d61aeed2346e055c86","tag/doubt":"6c9f9dae48a850cc3a552c5309c7ce6d","tag/endoftimes":"47c5c9e531869c2e13b7dede21c4911f","tag/suffering":"c893f944d3f62adbf81bcd323d92db16","tag/bible":"6001038ad3b00665e69981b25a39c35d","tag/persecution":"13de883c0596acbbd3466c1e832b0817","tag/christian-living":"871adaa6d21d23e0b833cdde2a13645b","tag/addiction":"b0f60dbd7118dd7a186266de3f9324f5","tag/teaching":"bc9df1b2e7a7ff3fb65802754b7a4704","tag/rest":"0894cf74d16473a8b72857f5e792df83","tag/hermenueutics":"53f6d5fbccd09e48e94451bf6e1db7f4","tag/practice":"f46e3dc7d3e48a65bebd46606b03f82b","tag/life-in-christ":"747f631d4fa78cecc0dab4aa173c88f3","tag/christian-practice":"ff2f143032a3a43847faba8007cdd3c0","tag/predestination":"d47dccd89ffd241f85f82173c94dbf0d","tag/current-issues":"79b90cc45cbe81e6100a409d6c90684f","tag/story":"7a9ec8c1f83c5fe59931b68c75d078f8","tag/humanitarian-aid":"df095c928584318c17eb9db55e9ebeab","tag/calvinism":"9f36ac7109979a9e8d3147f3b4608431","tag/sacrifice":"9e99e345025100907ab84554b1eda0e6","tag/catholicsm":"3412f986ff8cf61a3ea4478a3843e330"},"different":{"follow":{"live":["Follow Anabaptist Perspectives - Anabaptist Perspectives","Would you like Anabaptist Perspectives content delivered to your inbox? Would you like to be added to our print mailing list? You've come to the right place.","follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large","Instagram.png"],"ours":["Follow Anabaptist Perspectives - Anabaptist Perspectives","YouTube@AnabaptistPerspectives@DevelopingasaServant@AnabaptistOrigins@EssaysbyAnabaptistPerspectives","follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large","Instagram.png"]}}}}}`,
) as {
  excerptMd5: Record<Site, Record<string, string>>;
  ports: {
    inputs: string[];
    wpautop: string[];
    kses: string[];
    stripTags: string[];
    stripAllTags: string[];
    stripShortcodes: string[];
    excerpt: string[];
    truncate: [string, number, string][];
    ucwords: [string, string][];
    keyword: [string, string, string][];
    dates: [string, number, string, string][];
  };
  replacer: [string, Record<string, string>, string][];
  live: Record<
    Site,
    { table: Record<string, string>; different: Record<string, { live: string[]; ours: string[] }> }
  >;
};

interface Head {
  title?: string;
  description?: string;
  robots?: string;
  canonical?: string;
  og: Record<string, string[]>;
  tw: Record<string, string[]>;
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

/** What a rendered page says in its head, read the way a browser would. */
function parseHead(html: string): Head {
  const head: Head = { og: {}, tw: {} };
  const walk = (n: HastNode): void => {
    if (n.type === "element") {
      const props = n.properties ?? {};
      if (n.tagName === "title" && head.title === undefined) {
        head.title = (n.children ?? []).map((c) => c.value ?? "").join("");
      } else if (n.tagName === "meta") {
        const content = String(props.content ?? "");
        if (props.name === "description") head.description = content;
        else if (props.name === "robots") head.robots = content;
        else if (typeof props.property === "string" && props.property.startsWith("og:"))
          (head.og[props.property] ??= []).push(content);
        else if (typeof props.name === "string" && props.name.startsWith("twitter:"))
          (head.tw[props.name] ??= []).push(content);
      } else if (n.tagName === "link" && String(props.rel) === "canonical") {
        head.canonical = String(props.href);
      } else if (n.tagName === "body") {
        return;
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(fromHtml(html) as unknown as HastNode);
  return head;
}

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/**
 * The address of everything a visitor can open, as WordPress makes them: pages by their path, posts under the
 * permalink structure, custom post types and taxonomies under their rewrite slug, and the archives of types that have one.
 * (This is the routes module's job; here it is only enough to find the post behind a live address.)
 */
function routesOf(model: WpModel): Map<string, SeoTarget> {
  const acf = loadAcf(model);
  const routes = new Map<string, SeoTarget>();
  const path = (p: WpPost): string => {
    const parts = [p.slug];
    for (let cur = p; cur.parent && model.posts.get(cur.parent);) {
      cur = model.posts.get(cur.parent)!;
      parts.unshift(cur.slug);
    }
    return parts.join("/");
  };
  const front = trim(model.site.permalinkStructure.replace(/%postname%.*/, ""));
  for (const p of model.posts.values()) {
    if (p.status !== "publish") continue;
    if (p.type === "page") routes.set(path(p), { kind: "post", post: p });
    else if (p.type === "post") routes.set(trim(`${front}/${p.slug}`), { kind: "post", post: p });
    else {
      const type = acf.postTypes.get(p.type);
      if (type?.rewriteSlug) {
        routes.set(
          trim(
            `${type.rewriteWithFront ? `${front}/` : ""}${type.rewriteSlug}/${type.hierarchical ? path(p) : p.slug}`,
          ),
          { kind: "post", post: p },
        );
      }
    }
  }
  for (const type of acf.postTypes.values()) {
    if (type.hasArchive)
      routes.set(trim(type.hasArchive === true ? String(type.rewriteSlug) : type.hasArchive), {
        kind: "archive",
        postType: type.slug,
      });
  }
  const categoryBase = trim(model.options.get("category_base") || "category");
  const tagBase = trim(model.options.get("tag_base") || "tag");
  for (const t of model.terms.values()) {
    const base =
      t.taxonomy === "category"
        ? categoryBase
        : t.taxonomy === "post_tag"
          ? tagBase
          : acf.taxonomies.get(t.taxonomy)?.rewriteSlug;
    if (base) routes.set(`${base}/${t.slug}`, { kind: "term", term: t });
  }
  routes.set("", { kind: "home" });
  const posts = model.posts.get(model.site.pageForPosts);
  if (posts) routes.set(path(posts), { kind: "posts-page" });
  return routes;
}

// ── Hand-built models ────────────────────────────────────────────────────────────────────────────

let nextId = 5000;

function wpPost(o: Partial<WpPost> & { type?: string } = {}): WpPost {
  return {
    id: nextId++,
    type: "post",
    status: "publish",
    slug: "a-post",
    title: "A Post",
    content: "",
    excerpt: "",
    date: "2024-03-05T15:04:05.000Z",
    modified: "2024-03-05T15:04:05.000Z",
    parent: 0,
    menuOrder: 0,
    authorId: 0,
    guid: "",
    passwordProtected: false,
    ...o,
  };
}

function wpTerm(o: Partial<WpTerm> & { termId: number }): WpTerm {
  return {
    taxonomyId: o.termId,
    taxonomy: "category",
    slug: `term-${o.termId}`,
    name: `Term ${o.termId}`,
    description: "",
    parent: 0,
    count: 3,
    meta: {},
    ...o,
  };
}

function wpAttachment(o: Partial<WpAttachment> & { id: number }): WpAttachment {
  const file = o.file ?? `img-${o.id}.jpg`;
  return {
    url: `https://x.test/wp-content/uploads/${file}`,
    mime: "image/jpeg",
    title: "",
    alt: "",
    caption: "",
    file,
    sizes: [],
    parent: 0,
    ...o,
  };
}

interface Parts {
  meta?: Record<number, Record<string, unknown[]>>;
  /** Raw option values: the two Rank Math ones are given as objects and serialised here. */
  titles?: Record<string, unknown>;
  general?: Record<string, unknown>;
  options?: Record<string, string>;
  terms?: WpTerm[];
  rel?: Record<number, number[]>;
  attachments?: WpAttachment[];
  users?: WpUser[];
  site?: Partial<WpSite>;
  /** Leave the Rank Math titles option out of the options table. */
  noTitles?: boolean;
}

function modelOf(posts: WpPost[], parts: Parts = {}): WpModel {
  const options = new Map(Object.entries(parts.options ?? {}));
  options.set(
    "rank-math-options-titles",
    serialize({
      title_separator: "-",
      pt_post_description: "%excerpt%",
      robots_global: ["index"],
      advanced_robots_global: {
        "max-snippet": "-1",
        "max-video-preview": "-1",
        "max-image-preview": "large",
      },
      ...parts.titles,
    }),
  );
  if (parts.noTitles) options.delete("rank-math-options-titles");
  if (parts.general) options.set("rank-math-options-general", serialize(parts.general));
  return {
    site: {
      url: "https://x.test",
      home: "https://x.test",
      name: "X Site",
      description: "A tagline",
      permalinkStructure: "/%postname%/",
      showOnFront: "posts",
      pageOnFront: 0,
      pageForPosts: 0,
      activePlugins: ["seo-by-rank-math/rank-math.php"],
      theme: "t",
      language: "en-US",
      ...parts.site,
    },
    options,
    posts: new Map(posts.map((p) => [p.id, p])),
    postMeta: new Map(Object.entries(parts.meta ?? {}).map(([k, v]) => [Number(k), v])),
    attachments: new Map((parts.attachments ?? []).map((a) => [a.id, a])),
    terms: new Map((parts.terms ?? []).map((t) => [t.termId, t])),
    termsByPost: new Map(Object.entries(parts.rel ?? {}).map(([k, v]) => [Number(k), v])),
    users: new Map((parts.users ?? []).map((u) => [u.id, u])),
    menuItems: [],
    redirects: [],
  };
}

/** SEO for a hand-built post, with the settings and meta given. */
function seoOfPost(
  post: Partial<WpPost>,
  parts: Parts & { postMeta?: Record<string, unknown[]> } = {},
  opts: Parameters<typeof seoFor>[2] = {},
): Seo {
  const p = wpPost(post);
  const { postMeta, ...rest } = parts;
  const model = modelOf([p], {
    ...rest,
    meta: { ...rest.meta, ...(postMeta ? { [p.id]: postMeta } : {}) },
  });
  return seoFor(model, { kind: "post", post: p }, opts);
}

// ── The live pages, as the fixture HTML shows them ───────────────────────────────────────────────

describe("the live pages in the fixtures (title, description, robots, og:image)", () => {
  for (const site of ["fineline", "ap"] as const) {
    test(site, () => {
      const model = models[site];
      const dir = join(fixtureDir(site), "html");
      const routes = routesOf(model);
      const files = readdirSync(dir).filter((f) => f.endsWith(".html"));
      const unmatched: string[] = [];
      let matched = 0;
      for (const file of files) {
        const head = parseHead(readFileSync(join(dir, file), "utf8"));
        const path = trim(new URL(head.canonical!).pathname);
        const target = routes.get(path);
        if (!target) {
          unmatched.push(file);
          continue;
        }
        const seo = seoFor(model, target);
        const imageName = (u: string | undefined): string | undefined => u?.split("/").pop();
        expect({ file, title: seo.title }).toEqual({ file, title: decodeEntities(head.title!) });
        expect({ file, description: seo.description }).toEqual({
          file,
          description: decodeEntities(head.description ?? ""),
        });
        expect({ file, robots: seo.robots }).toEqual({ file, robots: head.robots! });
        expect({ file, image: seo.image?.url }).toEqual({ file, image: head.og["og:image"]?.[0] });
        expect({ file, image: imageName(seo.image?.url) }).toEqual({
          file,
          image: imageName(head.og["og:image"]?.[0]),
        });
        // The Open Graph and Twitter tags the same page prints.
        const og = (k: string): string | undefined => head.og[k]?.[0];
        expect(seo.openGraph.title).toBe(decodeEntities(og("og:title")!));
        expect(seo.openGraph.type).toBe(og("og:type")!);
        expect(seo.openGraph.siteName).toBe(decodeEntities(og("og:site_name")!));
        expect(seo.openGraph.locale).toBe(og("og:locale")!);
        if (!(site === "fineline" && file === "blog.html")) {
          // (A posts page's og:description is the excerpt of the first post in its loop, which belongs to the loop, not to the page.)
          expect(seo.openGraph.description).toBe(decodeEntities(og("og:description")!));
        }
        expect(seo.twitter.card).toBe(head.tw["twitter:card"]![0]!);
        expect(seo.twitter.title).toBe(decodeEntities(head.tw["twitter:title"]![0]!));
        expect(seo.twitter.image?.url).toBe(head.tw["twitter:image"]?.[0]);
        if (seo.image) {
          expect(seo.image.width).toBe(Number(og("og:image:width")));
          expect(seo.image.height).toBe(Number(og("og:image:height")));
          expect(seo.image.type).toBe(og("og:image:type")!);
          // (WordPress prints a title-derived alt text with its typography done: curly quotes and en dashes,
          // as `keeshons-story-…-part-3` shows.)
          expect(seo.image.alt ?? "").toBe(decodeEntities(og("og:image:alt")!));
        } else {
          expect(og("og:image")).toBeUndefined();
        }
        matched++;
      }
      // Six of six pages of fineline, and the four of ap's six whose posts are in the fixture database
      // (it keeps the newest 100 posts of a type; the other two essays are older).
      if (site === "fineline") {
        expect(matched).toBe(6);
        expect(unmatched).toEqual([]);
      } else {
        expect(matched).toBe(4);
        expect(unmatched.sort()).toEqual([
          "essays__get-in-the-way-of-evil.html",
          "essays__the-essence-of-anabaptism-dean-taylor.html",
        ]);
        for (const slug of ["get-in-the-way-of-evil", "the-essence-of-anabaptism-dean-taylor"]) {
          expect([...model.posts.values()].some((p) => p.slug === slug && p.type === "post")).toBe(
            false,
          );
        }
      }
    });
  }

  test("the posts page and the front page are pages of their own, and the title's separator and site name come from the settings", () => {
    const fl = models.fineline;
    expect(seoFor(fl, { kind: "posts-page" }).title).toBe("Blog - finelinepainting.pro");
    expect(seoFor(fl, { kind: "home" }).title).toBe(
      "Professional Painting Services In South Central PA",
    );
    expect(seoFor(models.ap, { kind: "posts-page" }).title).toBe(
      "Essays for King Jesus - Anabaptist Perspectives",
    );
    // The posts page has no description of its own, and the template gives it none (its content is empty).
    expect(seoFor(fl, { kind: "posts-page" }).description).toBe("");
  });
});

// ── The live site, page by page ──────────────────────────────────────────────────────────────────

describe("every page of the live sites whose post is in the fixture database", () => {
  // md5 of [title, description, robots, og:image's file name] as the live page printed them on 2026-10-01
  // (the image by file name: a media host serves the same file from its own root).
  const { live } = GOLDEN;

  for (const site of ["fineline", "ap"] as const) {
    test(site, () => {
      const model = models[site];
      const routes = routesOf(model);
      const { table, different } = live[site];
      const base = (u: string | undefined): string => u?.split("/").pop() ?? "";
      const wrong: string[] = [];
      for (const [path, hash] of Object.entries(table)) {
        const target = routes.get(path === "/" ? "" : path);
        expect(target, path).toBeDefined();
        const seo = seoFor(model, target!);
        if (
          md5(JSON.stringify([seo.title, seo.description, seo.robots, base(seo.image?.url)])) !==
          hash
        )
          wrong.push(path);
      }
      // Two pages of a hundred and more differ, because the database is older than the live site:
      // the page `follow` was edited on the day of the check (its text is not in the database), and the
      // term `adams-county-pa` had no posts in the database and has one on the live site now.
      expect(wrong.sort()).toEqual(Object.keys(different).sort());
      expect(Object.keys(table).length).toBeGreaterThan(site === "fineline" ? 130 : 200);
    });
  }

  test("what the two older pages differ in", () => {
    const { live } = GOLDEN;
    const term = live.fineline.different["service_area/adams-county-pa"]!;
    // Only the robots differ: the term is empty in the database (so noindex), and on the live site it is not.
    expect(term.live.filter((v, i) => v !== term.ours[i])).toEqual([
      "follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
    ]);
    expect(term.ours[2]).toBe("follow, noindex");
    const model = models.fineline;
    const adams = [...model.terms.values()].find((t) => t.slug === "adams-county-pa")!;
    expect(adams.count).toBe(0);
    expect([...model.termsByPost.values()].some((ids) => ids.includes(adams.termId))).toBe(false);
    // The text the live page prints is not in the database at all.
    const follow = live.ap.different.follow!;
    expect(follow.live[1]).toStartWith(
      "Would you like Anabaptist Perspectives content delivered to your inbox?",
    );
    expect(
      [...models.ap.posts.values()].some((p) =>
        p.content.includes("Would you like Anabaptist Perspectives content"),
      ),
    ).toBe(false);
    expect(follow.live.filter((v, i) => v !== follow.ours[i])).toHaveLength(1);
  });

  test("every post and term of both fixtures has SEO that can be printed", () => {
    for (const site of ["fineline", "ap"] as const) {
      const model = models[site];
      let n = 0;
      for (const post of model.posts.values()) {
        if (
          post.type === "attachment" ||
          post.type.startsWith("acf-") ||
          ["nav_menu_item", "wp_navigation"].includes(post.type)
        )
          continue;
        const seo = seoFor(model, { kind: "post", post });
        n++;
        expect(seo.title).not.toMatch(/[%<>]|[ \t\n\r]{2}/);
        expect(seo.title).toBe(php.trim(seo.title));
        expect(seo.title.length).toBeGreaterThan(0);
        expect(seo.robots).toMatch(/^(follow|index|nofollow|noindex)/);
        expect(seo.description).not.toMatch(/<[a-z/]/i);
        expect(seo.openGraph.type).toBe(
          post.type === "post" || post.type === "episode" ? "article" : seo.openGraph.type,
        );
      }
      for (const term of model.terms.values()) {
        const seo = seoFor(model, { kind: "term", term });
        n++;
        // A taxonomy Rank Math has no template for (a theme's, a menu's) gets no title of its own: WordPress's stands.
        expect(seo.title.length > 0).toBe(
          model.options.get("rank-math-options-titles")!.includes(`tax_${term.taxonomy}_title`),
        );
        expect(seo.openGraph.type).toBe("article");
      }
      expect(n).toBeGreaterThan(300);
    }
  });
});

// <differential-corpus>
// ── A seeded corpus of awkward input, held against PHP chunk by chunk ──────────────────────────────

/**
 * What PHP (8.3, with WordPress 6.8's `formatting.php`/`kses.php` and Rank Math 1.0.253's `Str` and `Replacer` loaded
 * outside WordPress) answered for each input below, as md5 prefixes of 100 answers at a time (a failing chunk
 * names where to look). The inputs are made, not recorded: {@link textCorpus} is the same on every run.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS: readonly string[] = [
  "a",
  "word",
  "two words",
  "Élan",
  "ñandú",
  "x y",
  " ",
  "  ",
  "\t",
  "\n",
  "\n\n",
  "\r\n",
  "\r",
  " ",
  "﻿",
  "\u0085",
  "<",
  ">",
  "< ",
  "<!--",
  "-->",
  "<!-->",
  "<?",
  "?>",
  "<?php x ?>",
  "<!",
  "<!x>",
  "</",
  "</ x>",
  "</1>",
  "<!DOCTYPE x>",
  "<![CDATA[",
  "]]>",
  "'",
  '"',
  "\\",
  '\\"',
  "=",
  "/",
  "-",
  "--",
  "&",
  "&amp;",
  "&amp",
  "&#65;",
  "&#x41;",
  "&#0;",
  "&#xD800;",
  "&#1114112;",
  "&#0065;",
  "&#x0041;",
  "&#128512;",
  "&#x1F600;",
  "&#9;",
  "&#10;",
  "&#11;",
  "&#12;",
  "&#13;",
  "&#14;",
  "&#31;",
  "&#32;",
  "&#55295;",
  "&#55296;",
  "&#57343;",
  "&#57344;",
  "&#65533;",
  "&#65534;",
  "&#65535;",
  "&#65536;",
  "&#1114111;",
  "&#x9;",
  "&#xA;",
  "&#xB;",
  "&#xD;",
  "&#x1F;",
  "&#x20;",
  "&#xD7FF;",
  "&#xD800;",
  "&#xDFFF;",
  "&#xE000;",
  "&#xFFFD;",
  "&#xFFFE;",
  "&#x10000;",
  "&#x10FFFF;",
  "&#x110000;",
  "&#X41;",
  "&#00041;",
  "&#0000000065;",
  "&nbsp;",
  "&hellip;",
  "&bogus;",
  "&Eacute;",
  "&frac12;",
  "&#8217;",
  "&lt;",
  "&gt;",
  "&apos;",
  "&quot;",
  "<p>",
  "</p>",
  '<p class="a">',
  "<P>",
  "</P>",
  "<p/>",
  "<b>",
  "</b>",
  "<i>",
  "<br>",
  "<br/>",
  "<br />",
  "<hr>",
  "<hr/>",
  "<div>",
  "</div>",
  "<ul>",
  "</ul>",
  "<ol>",
  "</ol>",
  "<li>",
  "</li>",
  "<blockquote>",
  "</blockquote>",
  "<pre>",
  "</pre>",
  "<pre class=x>",
  "<h2>",
  "</h2>",
  "<table>",
  "</table>",
  "<tr>",
  "<td>",
  "</td>",
  "<form>",
  "</form>",
  "<address>",
  "</address>",
  "<section>",
  "</section>",
  "<figure>",
  "</figure>",
  "<figcaption>",
  "</figcaption>",
  "<option>",
  "</option>",
  "<select>",
  "</select>",
  "<object>",
  "</object>",
  "<param x>",
  "<embed y>",
  "<source src=x>",
  "<track>",
  "<audio>",
  "</audio>",
  "<video>",
  "</video>",
  "[audio]",
  "[/video]",
  "<script>",
  "</script>",
  "<script>alert(1)</script>",
  "<style>",
  "</style>",
  "<style>p{}</style>",
  "<svg>",
  "</svg>",
  '<svg><path d="M0\n0"/></svg>',
  "<math>",
  "</math>",
  '<a href="x">',
  "<a href='>'>",
  '<a href="x>y">',
  "</a>",
  "<img src=x>",
  '<img alt="a>b" src=x>',
  '<span style="a:b">',
  "</span>",
  "[x]",
  "[x a=1]",
  "[/x]",
  '[caption id="a"]',
  "[/caption]",
  "[",
  "]",
  "[]",
  "[caption]x[/caption]",
  "<!-- wp:paragraph -->",
  "<!-- /wp:paragraph -->",
  "<!-- wpnl -->",
  "<!--more-->",
  "<!--nextpage-->",
  "%",
  "%title%",
  "5 > 3",
  "a < b",
  "1<2",
  "x>y",
  "<?xml ",
  "<?XML a-",
  "(",
  ")",
  "<!doctype html>",
  "<!DOCTYPE",
  "<a <b>",
  '<a "<b>">',
  "\0",
  "-->>",
];

/** WordPress's own kses never finishes on `<p><!--></<i></p>`, so the empty comment is only ever alone. */
const COMBINABLE = FRAGMENTS.filter((f) => f !== "<!-->");

/** `count` strings made of 1 to 7 fragments each, the same on every run. */
function textCorpus(count: number, seed = 20261002): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [...FRAGMENTS];
  while (out.length < count) {
    const n = 1 + Math.floor(rnd() * 7);
    let s = "";
    for (let i = 0; i < n; i++) s += COMBINABLE[Math.floor(rnd() * COMBINABLE.length)]!;
    out.push(s);
  }
  return out;
}

/** Instants spread over the year, plus the edges: a leap day, a year's end, the ISO week that straddles one, the DST changes of 2024 and 2025. */
const DATE_STAMPS: readonly number[] = (() => {
  const out: number[] = [];
  for (let m = 0; m < 12; m++)
    for (const d of [1, 2, 3, 11, 12, 13, 21, 22, 23, 28, 31])
      out.push(Date.UTC(2024, m, d, (d * 5 + m) % 24, (d * 7) % 60, (m * 11) % 60) / 1000);
  for (const [y, m, d, h] of [
    [2024, 1, 29, 0],
    [2024, 11, 31, 23],
    [2025, 0, 1, 0],
    [2026, 0, 1, 12],
    [2021, 0, 3, 5],
    [2020, 11, 31, 23],
    [2023, 0, 1, 0],
    [2023, 0, 2, 0],
    [2024, 2, 10, 6],
    [2024, 2, 10, 7],
    [2024, 10, 3, 5],
    [2024, 10, 3, 6],
    [2025, 2, 30, 0],
    [2025, 2, 30, 1],
    [2025, 9, 26, 23],
    [2025, 9, 26, 1],
    [1999, 11, 31, 23],
    [2000, 1, 29, 12],
    [1900, 5, 1, 0],
    [2100, 2, 1, 0],
    [2038, 0, 19, 4],
    [1970, 0, 1, 0],
    [2024, 5, 15, 11],
    [2024, 5, 15, 12],
    [2024, 5, 15, 13],
  ] as const)
    out.push(Date.UTC(y, m, d, h, 30, 15) / 1000);
  // Years the zones' own rules do not reach: only UTC is asked about them.
  out.push(
    -62167219200,
    -62198755200,
    253402300800,
    -100000000000,
    4102444800,
    253370764800,
    253402214399,
  );
  return out;
})();

const DATE_ZONES: readonly string[] = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Asia/Kolkata",
  "Australia/Lord_Howe",
  "America/St_Johns",
  "Pacific/Auckland",
  "Asia/Tokyo",
  "Europe/Dublin",
  "Asia/Kathmandu",
  "America/Sao_Paulo",
  "+05:30",
  "-03:00",
  "+00:00",
];

/** Where `T` is not tzdata's abbreviation by construction: a zone the English locales have no letters for (or letters tzdata does not use), and instants before the zones had abbreviations. */
const dateSkipped = (format: string, zone: string, unixSeconds: number): boolean =>
  (format === "T" &&
    (zone === "Asia/Tokyo" || zone === "Australia/Lord_Howe" || unixSeconds < 1_000_000_000)) ||
  (zone !== "UTC" && (unixSeconds < -2_208_988_800 || unixSeconds > 4_102_444_800));

const DATE_FORMATS: readonly string[] = [
  "d",
  "D",
  "j",
  "l",
  "N",
  "S",
  "w",
  "z",
  "W",
  "F",
  "m",
  "M",
  "n",
  "t",
  "L",
  "o",
  "Y",
  "y",
  "x",
  "X",
  "a",
  "A",
  "B",
  "g",
  "G",
  "h",
  "H",
  "i",
  "s",
  "u",
  "v",
  "e",
  "I",
  "O",
  "P",
  "p",
  "T",
  "Z",
  "c",
  "r",
  "U",
  "F j, Y",
  "g:i a",
  "Y-m-d",
  "D, d M Y",
  "l jS \\o\\f F Y",
  "\\\\",
  "jS F",
  "H\\h i\\m",
  "\\",
  "Y\\",
  "no escapes: Y",
];

const TEMPLATE_TOKENS: readonly string[] = [
  "%title%",
  "%sep%",
  "%sitename%",
  "%sitedesc%",
  "%page%",
  "%term%",
  "%name%",
  "%excerpt%",
  "%unknown%",
  "%xarg(F j, Y)%",
  "%xarg()%",
  "%xarg%",
  "%empty%",
  "%Title%",
  "%SEP%",
  " ",
  "  ",
  "\t",
  "\n",
  "-",
  "|",
  "&amp;",
  "<b>",
  "</b>",
  "<i>x</i>",
  "text",
  "Text",
  "%",
  "%%",
  " - ",
  " | ",
  "%sep%%sep%",
  " %sep% ",
  "% title %",
  "%title%%",
  "%title(x)%",
  "%xarg(a)(b)%",
  "*",
  ".",
  "(",
  "+",
  "é",
  "&raquo;",
  "»",
  "%a-b%",
  "%a_b%",
  "%a b%",
  "%1%",
  "%-%",
];

const TEMPLATE_VARSETS: readonly Record<string, string>[] = [
  {
    title: "Hello",
    sep: "-",
    sitename: "Site",
    sitedesc: "Tagline",
    page: "",
    term: "Term",
    excerpt: "An excerpt",
    name: "Ann",
    empty: "",
  },
  {
    title: "",
    sep: "|",
    sitename: "Site & Co",
    sitedesc: "",
    page: "Page 2 of 4",
    term: "",
    excerpt: "",
    name: "",
    empty: "",
  },
  {
    title: "A - B",
    sep: "-",
    sitename: "-Site-",
    sitedesc: "x",
    page: "- Page 2",
    term: "T",
    excerpt: "e",
    name: "n",
    empty: "",
  },
  {
    title: "<i>tag</i>",
    sep: "&raquo;",
    sitename: "S &amp; S",
    sitedesc: "",
    page: "",
    term: "",
    excerpt: "",
    name: "",
    empty: "",
  },
  {
    title: "%sitename%!",
    sep: "*",
    sitename: "S",
    sitedesc: "%title%",
    page: "",
    term: "",
    excerpt: "",
    name: "",
    empty: "",
  },
  {
    title: "T",
    sep: "",
    sitename: "S",
    sitedesc: "",
    page: "",
    term: "",
    excerpt: "",
    name: "",
    empty: "",
  },
  {
    title: "é",
    sep: "»",
    sitename: "É",
    sitedesc: "",
    page: "",
    term: "",
    excerpt: "",
    name: "",
    empty: "",
  },
];

/** `count` templates of 1 to 8 tokens, the same on every run. */
function templateCorpus(count: number, seed = 424242): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [...TEMPLATE_TOKENS];
  while (out.length < count) {
    const n = 1 + Math.floor(rnd() * 8);
    let s = "";
    for (let i = 0; i < n; i++) s += TEMPLATE_TOKENS[Math.floor(rnd() * TEMPLATE_TOKENS.length)]!;
    out.push(s);
  }
  return out;
}

/** What strip_tags decides on, as tokens: openers and closers of tags, comments and instructions, quotes, brackets and the letters of `xml` and `doctype`. */
const TAG_TOKEN_SETS: readonly (readonly string[])[] = [
  [
    "<",
    ">",
    "<?",
    "?>",
    "<!",
    "<!--",
    "-->",
    "!--",
    "--",
    "-",
    "!",
    "?",
    '"',
    "'",
    "\\",
    "(",
    ")",
    " ",
    "\n",
    "\t",
    "\r",
    "\v",
    "\f",
    "a",
    "=",
    "/",
    "\0",
    "xml",
    "XML",
    "xm",
    "m",
    "x",
    "l",
    "L",
    "doctype",
    "DOCTYPE",
    "doctyp",
    "e",
    "E",
    "php",
    "<?xml",
    "<?php",
    "<!DOCTYPE",
    "<!doctype",
    "<a ",
    "</a>",
    "<b>",
    "<br/>",
  ],
  // processing instructions: their parentheses, quotes and ends
  ["<?", "?>", "?", ">", "<", "'", '"', "\\", "(", ")", " ", "a", "<?xml", "xml", "<?php"],
  // comments and `<!` declarations
  [
    "<!",
    "<!--",
    "-->",
    "--",
    "-",
    "!",
    ">",
    "<",
    "'",
    '"',
    "\\",
    "doctype",
    "doctyp",
    "e",
    "E",
    " ",
    "<!DOCTYPE",
    "a",
  ],
  // tags: nesting, quotes, whitespace after an opener
  [
    "<",
    ">",
    "<a",
    "</a",
    " ",
    "\t",
    "\n",
    "\r",
    "\v",
    "\f",
    "'",
    '"',
    "\\",
    "=",
    "a",
    "<!",
    "<?",
    "-",
    "?",
  ],
];

/** `count` strings of 1 to 11 tokens, from each of the sets in turn. */
function tagCorpus(count: number, seed = 777): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  while (out.length < count) {
    const tokens = TAG_TOKEN_SETS[out.length % TAG_TOKEN_SETS.length]!;
    const n = 1 + Math.floor(rnd() * 11);
    let s = "";
    for (let i = 0; i < n; i++) s += tokens[Math.floor(rnd() * tokens.length)]!;
    out.push(s);
  }
  return out;
}

/** Pieces of markup around block elements, with the whitespace that wpautop is particular about. */
const HTML_PIECES = [
  "<object>",
  "</object>",
  "<param x>",
  "<embed>",
  "</embed>",
  "<audio>",
  "</audio>",
  "<video>",
  "</video>",
  "<source src=x>",
  "<track>",
  "[audio]",
  "[/audio]",
  "[video]",
  "[/video]",
  "<figcaption>",
  "</figcaption>",
  "<option>",
  "</option>",
  "<select>",
  "</select>",
  "<pre>",
  "</pre>",
  "<script>",
  "</script>",
  "<style>",
  "</style>",
  "<svg>",
  "</svg>",
  "<math>",
  "</math>",
  "\n",
  "\n\n",
  "\r\n",
  " ",
  "\t",
  "a",
  "word",
  "<p>",
  "</p>",
  "<br>",
  "<br/>",
  "<br />",
  "<hr>",
  "<hr/>",
  "<li>",
  "</li>",
  "<ul>",
  "</ul>",
  "<blockquote>",
  "</blockquote>",
  "<div>",
  "</div>",
  "<table>",
  "</table>",
  "<tr>",
  "<td>",
  "<h2>",
  "</h2>",
  "<span>",
  "</span>",
  "<!--",
  "-->",
  "<!-- wpnl -->",
  "<>",
  "< >",
  "<a\n>",
  "<a\nb>",
  "<![CDATA[",
  "]]>",
  "<![CDATA[]]>",
  "&nbsp;",
  "<form>",
  "</form>",
  "<address>",
  "<section>",
  "<figure>",
  "</figure>",
];

/** `count` strings of 2 to 9 of those pieces. */
function htmlCorpus(count: number, seed = 31337): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  while (out.length < count) {
    const n = 2 + Math.floor(rnd() * 8);
    let s = "";
    for (let i = 0; i < n; i++) s += HTML_PIECES[Math.floor(rnd() * HTML_PIECES.length)]!;
    out.push(s);
  }
  return out;
}

const CORPUS_DIGESTS = {
  text: {
    wpautop:
      "4c841a95,2b724e26,67ce40a0,0d4a7ab3,3532f845,de7d6eca,f0b062db,28624866,486766da,4571526d,f91b8f0d,8ed202a4,bc27c287,9cc97e97,06778290,38d85804,9fe04c8a,7a4dbbc4,0ecffac2,0005156b,42103cc1,019dff1d,4e66665e,833714fc,2414854b,e3bd194b,f12ee403,394fd064,f67692e5,70cbc914",
    kses: "3d3a2b92,d1c8b934,e82e62a9,699708c8,47554a6f,6ad0678d,d1bd7296,a07b68fc,89c7a073,c7e968c1,50997530,04b4752d,5d857212,e1a0aaec,a7a3c528,faf526c4,446e6194,3ca5e19c,df0000c2,6fb30524,371eb8a8,f7f005f0,619d7362,d5d37d64,6f099ef1,aa9a520d,b1e73648,2748b271,3bcdc8a2,63a61e9b",
    stripTags:
      "eff9c2c9,c492d011,83377a39,53075a7c,2f30fbcb,ef6cfed2,81c43b50,d68ea072,02de2873,ca13d2f6,dff68052,abc6de25,550bca5a,2b9fe23d,e93f0fd9,edde55ac,076402af,0959e324,f02174a9,5b1f16b9,3ab83e25,52f315b8,7e0e0294,a4c342ab,39ece64e,54a3a398,565b2a6d,37d029b3,927e8173,3522153c",
    stripAllTags:
      "13524017,4e5343e2,4def9a1e,8719fbd2,73dc5928,31d56a14,1709654f,9c8c7d30,68da7cc5,66320e60,6241939f,805ae5cf,c03e5108,59b3eba7,05ed63a8,599dd804,44324323,b09e01b7,b70651ce,a2f7de4e,dea636c0,d4691fd3,b3d3aff3,9c799436,327a4a28,6935c2c4,a9372dd9,cb101361,9cac49a7,f8593b4f",
    stripAllTagsBreaks:
      "13524017,4e5343e2,023e39cb,503e4006,dc63c55b,d0d3b731,17cfcf59,6e801e4a,8127d514,721a4f2f,f51641c0,805ae5cf,6b526e38,84e0e50e,7809d6cb,69d17742,d496af68,5b8a67b3,5fa999c8,d3bc0753,5024ab5a,2d721e5b,652eae08,f4d6ec78,8d8b6294,9a2aa57d,0a4ff47b,c3526b50,4b048d37,f36c8dfe",
    stripShortcodes:
      "878e3dca,e1884a3b,f8efd0c7,e0ce7ecb,e1f5c895,3d07dc11,b784962e,610aa0a6,2384e904,e504a9fc,56d2e72e,fa733605,88ea2308,c98a8c63,d0ce8636,bd6a7973,17255b25,62b13a7a,2a0354d0,083c03ff,a491802f,bddc7c0d,7d73e2b1,f89f06d6,cf695249,8d9d8779,2b248a39,5d33b750,2ed582a7,c84360a5",
    truncate:
      "0a2b963a,3fccd5d2,531ed8a6,de246fe9,38ce59da,6265015c,ba7bcfe9,51292f10,2765d984,db014a0a,4edc289c,67867a39,029b50c3,34a9ed5f,136031ed,31ce629c,ae985179,3f66d5bc,f73335ba,7a332204,f72a5e04,cd788b82,956a4ea6,99fe54fa,7691d58a,ff10a808,ecbeebc3,7d32b876,6d77aa2e,5fb71ec2",
    truncateDefault:
      "c63a3e1b,4e5343e2,3ff00586,ec21730e,c0bafa4e,d0d3b731,044b0b95,08ff0103,98431b57,c1e940c5,ed9f4d0e,cf250adb,d14d96ec,12856cf4,937363b0,f208e087,ca714413,013f2256,2615549d,d3bc0753,22ec7439,fc7f4876,d28d6603,784de5ce,2abd036c,cd725913,0a4ff47b,299c6775,d249b015,719891b5",
    ucwords:
      "a4282e37,96e36b65,e6352c8a,a2423ef7,cf6d6541,a122cfc4,d11e53d7,88c98f47,5a52972f,822c06c5,6bbf9a70,28200564,c882057e,af16319f,6410d6ad,feb6571b,171762f1,8394b018,f041e214,b0a5357d,d392422e,3bfa33e7,b242c8c2,daf3194b,ba2c400a,0ceb21fd,ca4013a2,b687fa9c,4f66ea63,061d2268",
    excerpt:
      "0915667f,8c6e4f7f,915f636e,69e418a9,42ab5da9,fd4e8667,a893b04a,0cd34fbd,06bc3d7e,34099616,8bb6231e,b77491bc,c9a60f35,83b4d564,c0f9c649,486910a1,6c9c05e4,7862820d,6a79192d,950154c6,27be6462,56aff6a5,ae914199,6503d61b,657e31ff,ac4ec298,fc21fd14,e9d7f2c4,048b93b2,2fce5c79",
    tagStripTags:
      "d939f865,6f06ed50,5ad5f196,0f071e50,284cffac,e2bfe2d5,542cd487,7dbc3229,32fef9be,ac1721be,f6220642,75068b3b,dc1b9abd,5732f68e,34b073ef,df1f0e06,15eb1c9f,1ee33f52,d35e3bfd,915c90e5,0f952d0d,b887cedd,125f52be,2fc38e49,9595e491,e10920e7,ac0cae63,8e667ef2,60b2fd8c,087e9d78,51dfb2f3,d8b25264,9d38fdf5,236edb1c,7faed5dd,643da5a5,57480fd8,acaab4cf,50914dbf,7116f46d,53d0b82b,513288a3,a83e5f31,b8204a82,f928616a,675bade1,a09cecfd,3c763a33,4def22f6,203aaa6a,524fdec5,333b0fa5,21e095cb,aa0eed54,3c6dde8a,84ebcf54,bf6b69b6,ef90e6af,4fc8b3c4,1224a1d6,98c0525f,46cc4057,3c90235c,bb7a1ef3,b6f61a6a,9286af4d,c93b94ff,43e60974,a314ef93,afdd1905,91bd9262,c158e3cb,9dbb9756,67e55634,b06a6bd1,68657010,63c385ba,df34a53c,1ae9896c,26608520,b46bb361,0ce03ba6,d74b8417,8c98d0ed,1e51e5b7,1359366f,eda8ae56,82c4ba57,ca8d24e3,5978ae42,4e6cd5e2,eb8387c7,73acb728,b77ae39c,848976f7,51e67b32,29b94e58,c82e6320,11c55922,96c51dc1,6667e0cf,2be6f88f,d6b2d130,46f3f43f,d5e5f03d,82d6344c,1995a9d0,6322f984,4c2b1307,72dccd13,beefe621,3f79c1b5,4d86720b,cd151d26,47bea97b,b3e941b0,cf60c3e3,c8b1d7a9,60047533,f1836c42",
    tagKses:
      "44878e29,f6627601,50d6b72c,30e3d691,42a0055b,86792f6d,26516d46,bcc4bc08,5b78e38a,6bfbf5b6,4c621726,0f978848,71e22ec5,42683537,7f3c849a,7f386a8c,2a5d38d9,6ca515ec,b0b2306a,44ae7c42,0ed516d0,c1ca8489,7701b4f3,8a31ff0d,f775c54c,563d311a,d35924cb,f99ad23e,f9e9562a,735a543f,89ffbe0f,bdbcb8e8,6040330b,f0a990a7,5b2921c9,147af5ee,72fae1b4,05154e4d,99e9719c,657cc2fa,c8ecb963,5b70eac6,196e0348,a706bba1,50e36134,cdac2577,dae3f115,fb8c2680,7ba54da9,eaacfa97,3f9f2f48,74bc8727,069e558a,4f208fb5,9c470b5e,9547d7d4,04e048ec,2697ae46,a2c06e66,750465f9,f0839dc5,99ad3515,1ea03261,e328c6dc,6da894cf,e2369458,84a8bfa8,bb17d775,8a91833b,b5a6abf4,dae54f2b,570d6b42,53ac565a,e30fb6c0,7b0a45c5,1d515176,b5024ed8,5012e747,c3e0c57b,c45f98cf,dd4f804a,cb739f47,a9e62ba4,ad371194,859fb8fa,b9ce04be,8b8ef28b,153159e8,2e645f3f,ba5e4a68,d0ef204f,35c56327,57b4d839,771683f5,88bf0d80,9af6bcb0,9d2cb767,2e381c99,ee957d0b,5d709975,5917a9bf,42bf74c3,4c87d6e4,c79c0726,c4742de2,4eea92a2,159d876d,e051e297,0f3473a6,08e0d6cf,715d29bf,b00bcfe5,24d8be21,a450c2f6,9e4a6c6e,2950241a,f311365e,fbe1efe8,617e325b,607ca7f2",
    htmlWpautop:
      "4523b9c0,307ee60b,c285226f,9934c13f,4e2d5776,8526a809,733f1ac2,40bf6f33,6cdb2e06,706d4892,58d98d61,f7caa58e,dfb90318,7b1a509f,3c622207,64f7bef0,1e6d5137,9dc01845,98338ecb,5eaf84df,6ed7dfb2,0beef0ad,3dc2ca21,731d3b24,9add45d8",
    htmlKses:
      "b1619fe0,4eefe387,fd04f1dd,293b98f5,a274eb44,c4df2851,eed26e31,28c91b6f,a9fcb9a3,d2cf1b0e,a91d91b9,96dbf3c3,6c4bc766,c8e86b48,de654a3c,211a17dd,d7dfac60,2bd9a69d,b95afd81,6d152a52,612ce191,951609de,cd211cf9,fcb17806,2f373c7c",
    htmlExcerpt:
      "a9a4f56d,8f45204c,7be83e87,020b7713,e3622a88,45e0c607,655e2d72,f5c62228,818b500d,cf7096a9,fe472b09,6fd1bbb2,5bbaaf71,6ea014bb,a17e42a1,4461b70b,4c4e2a4a,6dec57d7,b50098dd,898140a4,e672bc31,20bb1921,b0901529,8fe8ce3a,5796a4c4",
  },
  dates: {
    d: "2723424f,98b0eafe,a9e74989,faa1690e,087dad84,b049e3f1,84f78cfb,5dbf3982,a9e74989,d1923e97,5dbfa262,faa1690e,5dbfa262,5d216d63",
    D: "832b0a60,243e9972,37334581,bf7be214,fb4a8ac2,aa975a65,ef501df6,b8ac8d17,37334581,bef88fa6,4a63154c,bf7be214,4a63154c,c29d269b",
    j: "e0fab667,f0b23836,e3fb1da0,3b540423,1661709e,92f6fbff,56a79ead,da995de4,e3fb1da0,5c15e733,eb08f647,3b540423,eb08f647,1b08ac1e",
    l: "ffbbfc51,9af1288a,046be01a,9e16033f,377e5478,1dc57e8b,1051cfce,f8d45e54,046be01a,37a82ae5,a2a3bade,9e16033f,a2a3bade,3e702298",
    N: "9a9102ee,70eaf55b,57536a53,5335db6f,5dff5227,2bc4af4f,ecf0eb62,74c51bb3,57536a53,f384598d,22a8a4f0,5335db6f,22a8a4f0,8a573a0a",
    S: "417f85b1,29ae5827,36b006d6,764995e3,1d31030b,67203134,4426ba71,80efabb0,36b006d6,a7a1d114,b4c9d4dd,764995e3,b4c9d4dd,e2248bcd",
    w: "fbe64616,80b715d0,e0170008,99a02ee9,00ac353a,a680c10c,d79b6df1,3d056396,e0170008,dca21aab,3cff28d9,99a02ee9,3cff28d9,941aedfc",
    z: "4189698d,7c54b64b,69a7d916,ec6118ec,aa9b4d32,744f7b2b,6fc525b6,b6aa8523,69a7d916,10db411b,199347f4,ec6118ec,199347f4,01f529ea",
    W: "1ec838b3,0123ea68,6dc98868,be20a52e,d7f7e846,39f4bd9a,5193d631,026c0d88,6dc98868,be20a52e,39f4bd9a,be20a52e,39f4bd9a,8adf641a",
    F: "72aa2d8c,2178b39f,3799763e,d8bffd29,5cdb1d27,2178b39f,8f39ada2,e0093514,3799763e,d8bffd29,2178b39f,d8bffd29,2178b39f,3799763e",
    m: "d95647d8,d390af28,56cfd901,c27da20f,c888370e,d390af28,e54143a5,70bfe4e6,56cfd901,c27da20f,d390af28,c27da20f,d390af28,56cfd901",
    M: "24935be1,c81ec8b7,129ab453,6fc583a4,edc2706e,c81ec8b7,586be09d,a9a0a46c,129ab453,6fc583a4,c81ec8b7,6fc583a4,c81ec8b7,129ab453",
    n: "8fa98a45,5b656a3a,a2b7741e,2e7947df,7fbd7f5e,5b656a3a,c5234d33,b9e6c01a,a2b7741e,2e7947df,5b656a3a,2e7947df,5b656a3a,a2b7741e",
    t: "2436170d,1e7f9ccb,53947ded,1cc66e78,cfd1e619,1e7f9ccb,516d2c78,27681e18,53947ded,1cc66e78,1e7f9ccb,1cc66e78,1e7f9ccb,53947ded",
    L: "1cd8e77b,d8d1fc07,ea55d830,7e2cc5ea,7e2cc5ea,d8d1fc07,7e2cc5ea,7e2cc5ea,ea55d830,7e2cc5ea,d8d1fc07,7e2cc5ea,d8d1fc07,ea55d830",
    o: "8580fbc8,df676ef0,51a6f9c8,51a6f9c8,51a6f9c8,df676ef0,51a6f9c8,51a6f9c8,51a6f9c8,51a6f9c8,df676ef0,51a6f9c8,df676ef0,51a6f9c8",
    Y: "417da38a,8ed9a450,c83bf6c9,13e33097,13e33097,8ed9a450,13e33097,13e33097,c83bf6c9,13e33097,8ed9a450,13e33097,8ed9a450,c83bf6c9",
    y: "ba002c1c,4ca54236,4a411478,3f9a9f28,3f9a9f28,4ca54236,3f9a9f28,3f9a9f28,4a411478,3f9a9f28,4ca54236,3f9a9f28,4ca54236,4a411478",
    x: "78d2d050,8ed9a450,c83bf6c9,13e33097,13e33097,8ed9a450,13e33097,13e33097,c83bf6c9,13e33097,8ed9a450,13e33097,8ed9a450,c83bf6c9",
    X: "7f99070f,e7bbf8cc,c164f87c,f112cb36,f112cb36,e7bbf8cc,f112cb36,f112cb36,c164f87c,f112cb36,e7bbf8cc,f112cb36,e7bbf8cc,c164f87c",
    a: "293de1b2,bf94e645,c1e7f546,338c5a9e,bd78d8d2,c42d243c,d8cf2806,8abd3ee1,c1e7f546,41553fd5,34e1aa0e,338c5a9e,34e1aa0e,5b7b33bd",
    A: "8eae7553,31e3e034,5bb244fc,ef0802c4,75eb8874,59952461,a542a481,94f54a74,5bb244fc,a47c83c0,92def02b,ef0802c4,92def02b,a74c8958",
    B: "ddb9da28,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52,2d3bee52",
    g: "f709d5db,a1524c3b,779a51b4,32e77b51,8b89ee27,f65b1a81,359b989d,f236ac39,779a51b4,ef6aa900,35063a69,c40edf5b,f236ac39,7f85c6e8",
    G: "85285fe6,b9a68057,31c9b9c7,f12089db,882acd4a,3f045407,36e3de71,86338876,31c9b9c7,0ad1bbff,e96184c4,535776b0,36fa0bfc,5a5567db",
    h: "b1ad4489,a32e905a,e1b9e708,e53ee6d5,15e706c5,f19698e4,06949ab0,45baa967,e1b9e708,5039c96f,24d2dde5,8877b37a,45baa967,fb400e53",
    H: "c988124f,8bc7751f,83600965,4cfe3896,7fed11e0,d5611484,ab49c42d,8c757934,83600965,c287d231,e6fe9105,85a7236f,3629fb88,d4fe2323",
    i: "6adff1b5,8e243046,8e243046,f99393e1,62c27bd4,4ec99b53,aad5e672,8e243046,e42163a6,da208efb,931752ff,4cdab71a,8e243046,8e243046",
    s: "d16f5ced,edaa6013,edaa6013,7304b97f,edaa6013,637aa49f,edaa6013,edaa6013,2c7d1664,ee9450e5,f1cc0ad0,edaa6013,edaa6013,edaa6013",
    u: "de7970f0,71670462,71670462,71670462,71670462,71670462,71670462,71670462,71670462,71670462,71670462,71670462,71670462,71670462",
    v: "e2b2c98c,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0,5e767fe0",
    e: "aec55b1e,ea2e2cc7,c71969d2,10f3c91d,fe4341d1,3f4bbfa0,215ff6d0,65eebc98,58c5bbaf,f6075b7e,b03d09b8,8a14d89c,ea2ef83b,159421bf",
    I: "a9128a64,9c7103f9,b6e94d3c,6e76c56e,ef5f16e3,b2ce6f76,2146a87d,6e76c56e,430ec5b7,6e76c56e,c23a474a,6e76c56e,6e76c56e,6e76c56e",
    O: "11abab3c,854de4fa,89ca1b02,5cdd6119,57f6b004,58bd1da9,742c4206,a6088abd,90229970,3446d441,700dffdc,1f32a982,bf8a64b1,fb40ca02",
    P: "13384088,ba805c02,29a3e647,1137430a,ecbbec57,9cb165dc,fa58368b,0fbf5a2b,059dfcf8,fddd3632,649ab197,8a14d89c,ea2ef83b,159421bf",
    p: "3058a3e3,ba805c02,29a3e647,1137430a,ecbbec57,9cb165dc,fa58368b,0fbf5a2b,059dfcf8,fddd3632,649ab197,8a14d89c,ea2ef83b,e78fd2b8",
    T: "815ce906,493a093e,242b38fc,ee9e61ef,d41d8cd9,dec80211,16c6bd6b,d41d8cd9,c98b2001,3c281ecc,c76f52f8,59b77939,1989e5f6,d7db0601",
    Z: "a9128a64,65d63860,90868bf7,c9ac2580,1c0b1280,7557dc15,34b45287,50be87ab,62ce7f24,4500ac10,bba3bd10,c9dcb904,583f8f9c,6e76c56e",
    c: "6482830a,66c4cd8f,1487a57c,89d980b2,924da536,f6af2c87,b0944f12,8fcbbfe7,b90aab05,4c0f858c,944cd245,5ad154fb,7a4ac086,f7326ecf",
    r: "d493652a,5ce64d85,da9a9767,e781d096,6161e0ef,623be92c,00a06d8d,8cbed3f9,01907bf8,98b79f70,375a2eaf,41793552,fc5baea3,b4b9113c",
    U: "90720a5b,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff,e491c5ff",
    "F j, Y":
      "158511ed,aa923faf,4034e318,ae7acc38,3f210e1a,0c384fe2,09fab9db,c65f93de,4034e318,70745969,dd45294c,ae7acc38,dd45294c,2d117bf6",
    "g:i a":
      "4f8c4f86,25945b61,4d4d23f5,86f9f3c2,064d1d14,1994e1e6,fabc2e4e,15258bba,6dbc0d7d,9b6fabc5,b0f4642f,31807a49,6b0870d6,282778aa",
    "Y-m-d":
      "0128ed70,e20f0e43,6d41edf0,d51b7f2f,07144d3a,5afa1466,ae4c62d9,ad260ce9,6d41edf0,2433ebc4,7b61a9a6,d51b7f2f,7b61a9a6,ad7cf120",
    "D, d M Y":
      "0f5eadaa,d6b55d6d,32f41f17,52334bb2,f9d8cfe7,5f726e46,1a3a862b,267be930,32f41f17,b0c0d6b0,f8ae5b2c,52334bb2,f8ae5b2c,ae3dbec3",
    "l jS \\o\\f F Y":
      "5b2dca48,49431e3b,5c3e866e,e0283fbd,00fe7120,b5d9b0f8,fc51867d,986610ba,5c3e866e,d2e0f478,b32cafce,e0283fbd,b32cafce,ff1bbbee",
    "\\\\":
      "db3ad4a1,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471,e51bb471",
    "jS F":
      "7cdaab49,66273294,585e3080,11aa7901,6ee49f69,cef1ccb7,267cb941,c947f79c,585e3080,4e66cab7,fa8812ff,11aa7901,fa8812ff,65d7fc30",
    "H\\h i\\m":
      "6ab0ff79,dc0eb647,8ca328f1,bbd75dd3,6f8cd033,2845595b,5fb3168e,66fc5fce,343f0753,5c17bc47,d756d832,e9f5fa4c,7cb7bc2f,fa585f35",
    "\\": "038a9073,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd,d6c1facd",
    "Y\\":
      "59a9b845,a3dfbb32,6209f03a,28d41289,28d41289,a3dfbb32,28d41289,28d41289,6209f03a,28d41289,a3dfbb32,28d41289,a3dfbb32,6209f03a",
    "no escapes: Y":
      "7afaf7b3,d2f46292,013a6eef,239d9133,d625f22d,bf4bb7a9,6f09a406,2046e4e0,49242171,ef78e399,eb4cdb58,3c008558,cf9fb412,4ad24a5f",
  },
  templates: "18d30c92,0024ab36,e3645e58,4260fc57,d90ebe60,02ff0d0e,d690f481",
} as {
  text: Record<string, string>;
  dates: Record<string, string>;
  templates: string;
};

const digestOf = (answers: string[]): string => md5(answers.join("\u0001")).slice(0, 8);

describe("a seeded corpus of awkward text, against PHP's own answers", () => {
  const corpus = textCorpus(3000);
  const lengths = corpus.map((_, i) => 5 + ((i * 7) % 60));
  const chunked = (
    name: string,
    inputs: string[],
    run: (input: string, index: number) => string,
  ): void => {
    test(name, () => {
      const got: string[] = [];
      for (let from = 0; from < inputs.length; from += 100)
        got.push(digestOf(inputs.slice(from, from + 100).map((s, i) => run(s, from + i))));
      expect(got).toEqual(CORPUS_DIGESTS.text[name]!.split(","));
    });
  };
  chunked("wpautop", corpus, (s) => php.wpautop(s));
  chunked("kses", corpus, (s) => php.ksesParagraphs(s));
  chunked("stripTags", corpus, (s) => php.stripTags(s));
  chunked("stripAllTags", corpus, (s) => php.stripAllTags(s, false));
  chunked("stripAllTagsBreaks", corpus, (s) => php.stripAllTags(s, true));
  chunked("stripShortcodes", corpus, (s) => php.stripShortcodes(s));
  chunked("truncate", corpus, (s, i) => php.truncate(s, lengths[i]));
  chunked("truncateDefault", corpus, (s) => php.truncate(s));
  chunked("ucwords", corpus, (s) => php.ucwords(s));
  chunked("excerpt", corpus, (s) => php.excerptFromContent(s, ""));
  // Strings of the characters that strip_tags and kses decide on, and of markup around block elements.
  const tags = tagCorpus(12000);
  chunked("tagStripTags", tags, (s) => php.stripTags(s));
  chunked("tagKses", tags, (s) => php.ksesParagraphs(s));
  const html = htmlCorpus(2500);
  chunked("htmlWpautop", html, (s) => php.wpautop(s));
  chunked("htmlKses", html, (s) => php.ksesParagraphs(s));
  chunked("htmlExcerpt", html, (s) => php.excerptFromContent(s, ""));
});

describe("a seeded corpus of dates, against PHP's own answers", () => {
  const sample = (format: string, zone: string): string[] =>
    DATE_STAMPS.filter((t) => !dateSkipped(format, zone, t)).map((t) =>
      php.date(format, t * 1000, zone),
    );
  for (const format of DATE_FORMATS) {
    test(`the format ${JSON.stringify(format)} in ${DATE_ZONES.length} zones`, () => {
      expect(DATE_ZONES.map((zone) => digestOf(sample(format, zone)))).toEqual(
        CORPUS_DIGESTS.dates[format]!.split(","),
      );
    });
  }
});

describe("a seeded corpus of templates, against Rank Math's Replacer", () => {
  test("every template with every variable set", () => {
    const templates = templateCorpus(700);
    const got: string[] = [];
    for (let from = 0; from < templates.length; from += 100) {
      got.push(
        digestOf(
          templates.slice(from, from + 100).map((t) =>
            TEMPLATE_VARSETS.map((vars) =>
              renderRankMathTemplate(t, {
                ...vars,
                xarg: (a: string) => (a === "" ? "<none>" : `[${a}]`),
              }),
            ).join("\u0002"),
          ),
        ),
      );
    }
    expect(got).toEqual(CORPUS_DIGESTS.templates.split(","));
  });
});
// </differential-corpus>

// ── Ports of the PHP functions ───────────────────────────────────────────────────────────────────

describe("ports of WordPress and Rank Math functions, against PHP's own answers", () => {
  const golden = GOLDEN;
  const { ports } = golden;

  const each = (name: keyof typeof ports & string, run: (input: string) => string): void => {
    test(name, () => {
      const expected = ports[name as "wpautop"];
      ports.inputs.forEach((input, i) => {
        expect({ name, input, got: run(input) }).toEqual({ name, input, got: expected[i]! });
      });
    });
  };
  each("wpautop", (s) => php.wpautop(s));
  each("kses", (s) => php.ksesParagraphs(s));
  each("stripTags", (s) => php.stripTags(s));
  each("stripShortcodes", (s) => php.stripShortcodes(s));
  test("stripAllTags with breaks removed", () => {
    ports.inputs.forEach((input, i) =>
      expect({ input, got: php.stripAllTags(input, true) }).toEqual({
        input,
        got: ports.stripAllTags[i]!,
      }),
    );
  });
  test("the paragraph a post's description is made of", () => {
    ports.inputs.forEach((input, i) =>
      expect({ input, got: php.excerptFromContent(input, "") }).toEqual({
        input,
        got: ports.excerpt[i]!,
      }),
    );
    // With a focus keyword: the first paragraph that holds it (case-insensitively, a space matching any character).
    for (const [input, keyword, expected] of ports.keyword)
      expect({ input, keyword, got: php.excerptFromContent(input, keyword) }).toEqual({
        input,
        keyword,
        got: expected,
      });
  });
  test("truncation at a word, never inside an entity", () => {
    for (const [input, length, expected] of ports.truncate)
      expect({ input, length, got: php.truncate(input, length) }).toEqual({
        input,
        length,
        got: expected,
      });
  });
  test("capitalised words: the first byte decides, so a word that starts with a multibyte letter is left alone", () => {
    for (const [input, expected] of ports.ucwords)
      expect({ input, got: php.ucwords(input) }).toEqual({ input, got: expected });
    expect(php.ucwords("élan vital")).toBe("élan Vital");
  });
  test("dates in a zone, for the format letters WordPress's date formats use", () => {
    for (const [format, stamp, zone, expected] of ports.dates) {
      expect({ format, zone, got: php.date(format, stamp * 1000, zone) }).toEqual({
        format,
        zone,
        got: expected,
      });
    }
    expect(ports.dates.length).toBeGreaterThan(100);
  });
  test("a zone abbreviation is what the runtime knows it as (US zones: EST, EDT; elsewhere an offset)", () => {
    expect(php.date("T e", 1700000000_000, "America/New_York")).toBe("EST America/New_York");
    expect(php.date("T", 1720000000_000, "America/New_York")).toBe("EDT");
    expect(php.date("T O P p Z", 0, "UTC")).toBe("UTC +0000 +00:00 Z 0");
    expect(php.date("e", 0, "UTC")).toBe("UTC");
  });

  test("the paragraph made of every post of both fixtures matches PHP's (a hash of the paragraph and of the autop'd content)", () => {
    for (const site of ["fineline", "ap"] as const) {
      const model = models[site];
      const wrong: string[] = [];
      let n = 0;
      for (const post of model.posts.values()) {
        if (post.type === "attachment" || post.content === "") continue;
        const keyword = model.postMeta.get(post.id)?.rank_math_focus_keyword?.[0];
        const got = md5(
          `${php.excerptFromContent(post.content, typeof keyword === "string" ? keyword : "")}\u0000${php.wpautop(post.content)}`,
        ).slice(0, 12);
        n++;
        if (got !== golden.excerptMd5[site][post.id]) wrong.push(`${post.id}:${post.type}`);
      }
      expect(wrong).toEqual([]);
      expect(n).toBe(Object.keys(golden.excerptMd5[site]).length);
      expect(n).toBeGreaterThan(200);
    }
  });

  test("wpautop's corners (each answer is PHP's)", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["  \n ", ""],
      ["one\n\ntwo", "<p>one</p>\n<p>two</p>\n"],
      ["one\ntwo", "<p>one<br />\ntwo</p>\n"],
      ["a<br><br>b", "<p>a</p>\n<p>b</p>\n"],
      // A pre block is left exactly as it is.
      ["<pre>x\n\ny</pre>", "<pre>x\n\ny</pre>\n"],
      // Newlines inside a tag's attributes are kept, and so are a script's.
      ['<img\nalt="a"> x', '<p><img\nalt="a"> x</p>\n'],
      ["<script>\nvar a;\n</script>", "<p><script>\nvar a;\n</script></p>\n"],
      ["<select>\n<option>a</option>\n</select>", "<p><select><option>a</option></select></p>\n"],
      [
        "<figure>\n<img src=x>\n<figcaption>\ncap\n</figcaption>\n</figure>",
        "<figure>\n<img src=x><figcaption>\ncap<br />\n</figcaption></figure>\n",
      ],
      [
        "<object>\n<param name=a>\n<embed src=x>\n</object>",
        "<p><object><param name=a><embed src=x></object></p>\n",
      ],
      [
        "<video>\n<source src=a>\n<track src=b>\n</video>",
        "<p><video><source src=a><track src=b></video></p>\n",
      ],
      // CDATA is one element, closed or not; a closing pre with no opener is plain text; several pre blocks each keep theirs.
      ["a<![CDATA[x\n\ny]]>b", "<p>a<![CDATA[x\n\ny]]>b</p>\n"],
      ["a<![CDATA[unterminated\n\nz", "<p>a<![CDATA[unterminated\n\nz\n</p>\n"],
      ["a</pre>b<pre>c\n\nd</pre>e", "<p>ab</p>\n<pre>c\n\nd</pre>\n<p>e</p>\n"],
      ["x</pre>y", "<p>x</pre>\n<p>y</p>\n"],
      ["<pre>a</pre> mid <pre>b</pre>", "<pre>a</pre>\n<p> mid </p>\n<pre>b</pre>\n"],
      ["<pre>unclosed\n\nstill", "<pre>unclosed</p>\n<p>still</p>\n"],
    ];
    for (const [input, expected] of cases)
      expect({ input, got: php.wpautop(input) }).toEqual({ input, got: expected });
    expect(php.wpautop("one\ntwo", false)).toBe("<p>one\ntwo</p>\n");
  });

  test("strip_tags, wp_strip_all_tags and wp_kses on the awkward cases (each answer is PHP's)", () => {
    // A `<` that opens nothing is text; one that opens a tag that never closes takes the rest of the text with it.
    const strip: [string, string][] = [
      ["a < b", "a < b"],
      ["a <b", "a "],
      ["5 > 3", "5 > 3"],
      ['<a href="x>y">t</a>', "t"],
      ["<p>x</p><!-- c --><?php y ?>z", "xz"],
      ["a\u0000b", "ab"],
      ["<!DOCTYPE html>t", "t"],
      ["<a <b> c>d", "d"],
      ["<!-- never closed", ""],
      ["<? never closed", ""],
      ["<!--->t", "t"],
      ["<!-->t", "t"],
      ["<!-- a --->t", "t"],
      ["<a href='x>y'>q</a>", "q"],
      ["x <y z", "x "],
      ["<br/>a<br />b", "ab"],
    ];
    for (const [input, expected] of strip)
      expect({ input, got: php.stripTags(input) }).toEqual({ input, got: expected });
    const kses: [string, string][] = [
      ['<p class="a" id=b>x</p> <b>bold</b> <p/>', "<p>x</p> bold <p />"],
      [
        "a & b &amp; &copy; &bogus; &#38; &#x26; &#0; &#xD800;",
        "a &amp; b &amp; &copy; &amp;bogus; &#038; &#x26; &amp;#0; &amp;#xD800;",
      ],
      ["x > y", "x &gt; y"],
      ["<!-- a -- b -->t", "<!-- a - b -->t"],
      ["<!--->t", "<!---&gt;t-->"],
      ["</1 odd>t", "</1 odd>t"],
      ["<!doctype x>t", "<!doctype x>t"],
      ["<<>>", "&gt;"],
      ["<P ID=1>u</P>", "<P>u</P>"],
      ["<p\nclass=a>n</p>", "<p>n</p>"],
      ["<p>a</p\n>", "<p>a</p>"],
      ["<p>x</P>", "<p>x</P>"],
      // A bogus comment is kept, with what is inside it cleaned until it stops changing.
      ["</1 &x>t", "</1 &amp;x>t"],
      ["</1 &amp;x>t", "</1 &amp;x>t"],
      ["<!x &y>t", "<!x &amp;y>t"],
      ["<!x a>b", "<!x a>b"],
      ["</1 <p>t", "</1 <p>>t"],
      ["<!x <p>t", "<!x <p>>t"],
    ];
    for (const [input, expected] of kses)
      expect({ input, got: php.ksesParagraphs(input) }).toEqual({ input, got: expected });
    const all: [string, boolean, string][] = [
      ["<script>x</script>y <style>z</style>w", false, "y w"],
      ["  a\n\t b  ", true, "a b"],
      ["  a\n b  ", false, "a\n b"],
      // A no-break space is not whitespace to PHP's trim.
      ["a\u00a0 b\u00a0", true, "a\u00a0 b\u00a0"],
    ];
    for (const [input, breaks, expected] of all)
      expect({ input, got: php.stripAllTags(input, breaks) }).toEqual({ input, got: expected });
  });

  test("PHP's trim and stripslashes", () => {
    expect(php.trim(" \t\n\r\0\x0Bx  ")).toBe("x ");
    expect(php.trim("xxaxx", "x")).toBe("a");
    expect(php.stripSlashes("a\\'b\\\\c\\0d\\")).toBe("a'b\\c\0d");
  });

  test("shortcodes and captions (each answer is PHP's)", () => {
    const cases: [string, string][] = [
      ["no brackets", "no brackets"],
      ["a [b c=d] e [/b] f", "a  e  f"],
      ["a [caption x]<img> text[/caption] b", "ab"],
      // The first `]` ends the shortcode: a bracket in the text after it is untouched.
      ["[a]b]", "b]"],
      ["a [[nested]] b", "a ] b"],
      ["text [unterminated", "text [unterminated"],
      ["[caption]x[/caption]", ""],
      ["x\n[caption]\ny\n[/caption]\nz", "xz"],
    ];
    for (const [input, expected] of cases)
      expect({ input, got: php.stripShortcodes(input) }).toEqual({ input, got: expected });
  });
});

// ── Templates ────────────────────────────────────────────────────────────────────────────────────

describe("renderRankMathTemplate", () => {
  const { replacer } = GOLDEN;

  test("agrees with Rank Math's own Replacer on every template of both sites, with edge cases, over four sets of values", () => {
    expect(replacer.length).toBeGreaterThan(90);
    for (const [template, values, expected] of replacer) {
      const vars: Record<string, string | ((arg: string) => string)> = {
        ...values,
        xarg: (arg) => (arg === "" ? "<none>" : `[${arg}]`),
      };
      expect({ template, values, got: renderRankMathTemplate(template, vars) }).toEqual({
        template,
        values,
        got: expected,
      });
    }
  });

  test("unknown variables print nothing and are reported with where they were found", () => {
    const report = createReport();
    const text = renderRankMathTemplate(
      "%title% %nope% %other(x)%",
      { title: "T" },
      { report, where: "post:5", url: "https://x.test/?p=5" },
    );
    // (the replacer does not trim; the title's own trim comes later)
    expect(text).toBe("T ");
    const found = codes(report, "seo.unknown-variable");
    expect(found.map((e) => e.data)).toEqual([
      { variable: "nope", template: "%title% %nope% %other(x)%" },
      { variable: "other", template: "%title% %nope% %other(x)%" },
    ]);
    expect(found[0]).toMatchObject({
      severity: "warn",
      where: "post:5",
      url: "https://x.test/?p=5",
    });
    // Without a report the same template renders the same.
    expect(renderRankMathTemplate("%title% %nope%", { title: "T" })).toBe("T ");
  });

  test("a name Rank Math knows that has no value here prints nothing, and is not an error", () => {
    const report = createReport();
    expect(renderRankMathTemplate("%term% | %title%", { title: "T" }, { report })).toBe(" | T");
    expect(renderRankMathTemplate("%term% | %title%", { title: "T", term: null }, { report })).toBe(
      " | T",
    );
    // Variables with nothing between them are one token to the plugin, which does not know that name.
    expect(renderRankMathTemplate("%term%|%title%", { title: "T", term: "x" })).toBe("");
    expect(report.entries()).toEqual([]);
  });

  test("a variable the caller defines is known even though Rank Math has no such name", () => {
    const report = createReport();
    expect(renderRankMathTemplate("%mine%", { mine: "x" }, { report })).toBe("x");
    expect(report.entries()).toEqual([]);
  });

  test("variables that read the clock are reported once per place", () => {
    const report = createReport();
    const vars: RankMathVars = { currentyear: "2026", sitename: "S" };
    expect(
      renderRankMathTemplate("%sitename% %currentyear%", vars, {
        report,
        where: "option:pt_x_title",
      }),
    ).toBe("S 2026");
    renderRankMathTemplate("%currentyear% %currentyear%", vars, {
      report,
      where: "option:pt_x_title",
    });
    renderRankMathTemplate("%currentyear%", vars, { report, where: "post:9", url: "u" });
    renderRankMathTemplate("%currentyear%", vars, { report });
    expect(codes(report, "seo.dynamic-variable").map((e) => e.where)).toEqual([
      "option:pt_x_title",
      "post:9",
    ]);
    expect(codes(report, "seo.dynamic-variable")[1]).toMatchObject({ severity: "info", url: "u" });
  });

  test("arguments: the function gets the text between the brackets", () => {
    const seen: string[] = [];
    const vars: RankMathVars = {
      date: (arg) => {
        seen.push(arg);
        return `d(${arg})`;
      },
    };
    // `%date()%` has an empty argument list, which the plugin does not read as the variable `date`.
    expect(renderRankMathTemplate("%date% %date(F jS, Y)% %date()%", vars)).toBe("d() d(F jS, Y) ");
    expect(seen).toEqual(["", "F jS, Y"]);
    // `name_args` is how Rank Math lists a variable that takes an argument, and works as a fallback key.
    expect(renderRankMathTemplate("%x(1)%", { x_args: (a) => `A${a}` })).toBe("A1");
  });

  test("the separator is replaced and repeated separators collapse only when the template uses it", () => {
    expect(
      renderRankMathTemplate("%title% %sep% %sitename%", { title: "T", sep: "|", sitename: "S" }),
    ).toBe("T | S");
    expect(
      renderRankMathTemplate("%title% %sep% %sep% %sitename%", {
        title: "T",
        sep: "|",
        sitename: "S",
      }),
    ).toBe("T | S");
    expect(
      renderRankMathTemplate("%title% | | %sitename%", { title: "T", sep: "|", sitename: "S" }),
    ).toBe("T | | S");
    // An empty title leaves a separator in front, which is how Rank Math prints it.
    expect(
      renderRankMathTemplate("%title% %sep% %sitename%", { title: "", sep: "-", sitename: "S" }),
    ).toBe(" - S");
    // A trailing separator is dropped, and its space stays (the title's own trim removes it later).
    expect(renderRankMathTemplate("%title% %sep%", { title: "T", sep: "-" })).toBe("T ");
    // A separator that is a regex character is quoted.
    expect(renderRankMathTemplate("a %sep% %sep% b", { sep: "*" })).toBe("a * b");
  });

  test("tags in the template are stripped, whitespace collapses, and substitutions apply one after the other", () => {
    expect(renderRankMathTemplate("<b>%title%</b>\n  x", { title: "T" })).toBe("T x");
    expect(renderRankMathTemplate("100% sure", {})).toBe("100% sure");
    expect(renderRankMathTemplate("no variables at all", {})).toBe("no variables at all");
    // A value that itself holds a later variable is replaced again, as str_replace with arrays does.
    expect(
      renderRankMathTemplate("%title% %sitename%", { title: "%sitename%!", sitename: "S" }),
    ).toBe("S! S");
  });
});

// ── Titles ───────────────────────────────────────────────────────────────────────────────────────

describe("titles", () => {
  test("a post's own title wins over the template and has its variables replaced", () => {
    expect(
      seoOfPost(
        { title: "Post" },
        { postMeta: { rank_math_title: ["Custom %title% %sep% %sitename%"] } },
      ).title,
    ).toBe("Custom Post - X Site");
    expect(seoOfPost({ title: "Post" }, { postMeta: { rank_math_title: ["Custom"] } }).title).toBe(
      "Custom",
    );
    // The stored `%seo_title%` is the title.
    expect(
      seoOfPost({ title: "Post" }, { postMeta: { rank_math_title: ["%seo_title% (SEO)"] } }).title,
    ).toBe("Post (SEO)");
  });

  test("the template for the type, and Rank Math's default when there is none", () => {
    expect(
      seoOfPost(
        { title: "Post" },
        { titles: { pt_post_title: "%title% | %sitename%", title_separator: "|" } },
      ).title,
    ).toBe("Post | X Site");
    expect(
      seoOfPost(
        { title: "Post", type: "book" },
        { titles: { pt_book_title: "Book: %title% %page%" } },
      ).title,
    ).toBe("Book: Post");
    // No setting for the type: `%title% %sep% %sitename%`.
    expect(seoOfPost({ title: "Post", type: "unknown_type" }).title).toBe("Post - X Site");
    // A template emptied out on purpose is the same.
    expect(seoOfPost({ title: "Post" }, { titles: { pt_post_title: "" } }).title).toBe(
      "Post - X Site",
    );
  });

  test("text, as the browser shows it: entities decoded once, tags gone, whitespace collapsed", () => {
    expect(seoOfPost({ title: "Fish &amp; Chips" }).title).toBe("Fish & Chips - X Site");
    expect(seoOfPost({ title: "Fish & Chips" }).title).toBe("Fish & Chips - X Site");
    expect(seoOfPost({ title: "A  <em>very</em>\n spaced   title" }).title).toBe(
      "A very spaced title - X Site",
    );
    expect(seoOfPost({ title: "Keeshon&rsquo;s Story" }).title).toBe("Keeshon’s Story - X Site");
    expect(seoOfPost({ title: "Don\\'t" }).title).toBe("Don't - X Site");
    // The site's name is stored encoded.
    expect(seoOfPost({ title: "P" }, { site: { name: "Missions &amp; Evangelism" } }).title).toBe(
      "P - Missions & Evangelism",
    );
    // Decoded once: a stored `&amp;amp;` shows `&amp;`.
    expect(seoOfPost({ title: "&amp;amp;" }).title).toBe("&amp; - X Site");
  });

  test("capitalised titles, when the site asks for them", () => {
    expect(
      seoOfPost({ title: "a post about things" }, { titles: { capitalize_titles: "on" } }).title,
    ).toBe("A Post About Things - X Site");
    expect(seoOfPost({ title: "a post" }, { titles: { capitalize_titles: "off" } }).title).toBe(
      "a post - X Site",
    );
    expect(seoOfPost({ title: "élan 3d" }, { titles: { capitalize_titles: "on" } }).title).toBe(
      "élan 3d - X Site",
    );
  });

  test("the separator comes from the settings, entity or character", () => {
    expect(seoOfPost({ title: "T" }, { titles: { title_separator: "&raquo;" } }).title).toBe(
      "T » X Site",
    );
    expect(seoOfPost({ title: "T" }, { titles: { title_separator: "—" } }).title).toBe(
      "T — X Site",
    );
    expect(seoOfPost({ title: "T" }, { titles: { title_separator: "&" } }).title).toBe(
      "T & X Site",
    );
  });

  test("the title variables of a post", () => {
    const parent = wpPost({ id: 100, title: "Parent Page", slug: "parent" });
    const author: WpUser = { id: 7, slug: "ann", displayName: "Ann Author" };
    const cats = [
      wpTerm({ termId: 1, name: "Zebra", slug: "zebra" }),
      wpTerm({ termId: 2, name: "Apple", slug: "apple" }),
      wpTerm({
        termId: 3,
        name: "News &amp; Views",
        slug: "news",
        taxonomy: "post_tag",
        description: "Tag description",
      }),
    ];
    const post = wpPost({
      id: 101,
      title: "Child",
      slug: "child",
      parent: 100,
      authorId: 7,
      date: "2024-03-05T15:04:05.000Z",
      modified: "2024-03-09T01:00:00.000Z",
      type: "page",
      content: "<p>The body.</p>",
    });
    const build = (template: string): WpModel =>
      modelOf([parent, post], {
        terms: cats,
        rel: { 101: [1, 2, 3] },
        users: [author],
        site: { language: "en-US" },
        options: {
          timezone_string: "America/New_York",
          date_format: "F j, Y",
          time_format: "g:i a",
        },
        meta: {
          101: {
            rank_math_focus_keyword: ["body, other"],
            custom: ["Value"],
            _thumbnail_id: ["9"],
            rank_math_title: [""],
          },
        },
        attachments: [
          wpAttachment({
            id: 9,
            file: "pic.jpg",
            url: "https://x.test/wp-content/uploads/pic.jpg",
          }),
        ],
        titles: { pt_page_primary_taxonomy: "category", pt_page_title: template },
      });
    const render = (template: string): string =>
      seoFor(build(template), { kind: "post", post }).title;
    expect(render("%title%")).toBe("Child");
    expect(render("%parent_title%")).toBe("Parent Page");
    expect(render("%id%")).toBe("101");
    expect(render("%userid% %name% %post_author%")).toBe("7 Ann Author Ann Author");
    // The first category by name, and all of them by name.
    expect(render("%category%")).toBe("Apple");
    expect(render("%categories%")).toBe("Apple, Zebra");
    expect(render("%categories(limit=1)%")).toBe("Apple");
    expect(render("%categories(separator= | )%")).toBe("Apple | Zebra");
    expect(render("%categories(exclude=2)%")).toBe("Zebra");
    expect(render("%tag% / %tags%")).toBe("News & Views / News & Views");
    expect(render("%primary_taxonomy_terms%")).toBe("Apple, Zebra");
    expect(render("%customterm(post_tag)% [%customterm(none)%]")).toBe("News & Views []");
    expect(render("[%customterm_desc(post_tag)%] [%customterm_desc(none)%]")).toBe(
      "[Tag description] []",
    );
    expect(render("%focuskw% / %keywords%")).toBe("body / body, other");
    expect(render("%customfield(custom)% [%customfield(missing)%]")).toBe("Value []");
    // The date in the site's zone, with WordPress's own format or the one given: 15:04 UTC is 10:04 in New York.
    expect(render("%date%")).toBe("March 5, 2024");
    expect(render("%date(g:i a T)%")).toBe("10:04 am EST");
    expect(render("%modified%")).toBe("March 8, 2024");
    expect(render("%modified(Y-m-d H:i)%")).toBe("2024-03-08 20:00");
    expect(render("%pt_single% / %pt_plural%")).toBe("Page / Pages");
    expect(render("%excerpt%")).toBe("The body.");
    expect(render("%excerpt_only%")).toBe("");
    expect(render("%url%")).toBe("");
    expect(render("%post_thumbnail%")).toBe("https://x.test/wp-content/uploads/pic.jpg");
    expect(render("%pagenumber% of %pagetotal% %page%")).toBe("1 of 1");
    expect(render("%sitename% / %sitedesc% / %org_name% / %org_url%")).toBe(
      "X Site / A tagline / X Site / https://x.test",
    );
    expect(
      render("%search_query% %count(x)% %filename% %user_description% %term% %term_description%"),
    ).toBe("1");
  });

  test("a term's variables: its name and description, its own meta, and none of a post's", () => {
    const term = wpTerm({
      termId: 60,
      taxonomy: "genre",
      slug: "jazz",
      name: "Jazz",
      description: "Cool",
      meta: { rank_math_focus_keyword: "swing, bop", colour: "blue", number: 7, list: ["x"] },
    });
    const render = (template: string): string => {
      const model = modelOf([], { terms: [term], titles: { tax_genre_title: template } });
      return seoFor(model, { kind: "term", term }).title;
    };
    expect(render("%term% %term_description%")).toBe("Jazz Cool");
    expect(render("%focuskw% | %keywords%")).toBe("swing | swing, bop");
    expect(
      render(
        "%customfield(colour)% %customfield(number)% [%customfield(list)%] [%customfield(none)%]",
      ),
    ).toBe("blue 7 [] []");
    expect(render("%title% %id% %excerpt% %name% %category% %date%")).toBe("");
    expect(render("%pt_single% %pt_plural% %customterm(x)% %customfield()%")).toBe("");
  });

  test("a zone the runtime does not know is the offset, or UTC", () => {
    const post = wpPost();
    const title = (options: Record<string, string>): string =>
      seoFor(modelOf([post], { titles: { pt_post_title: "%date(H:i T e)%" }, options }), {
        kind: "post",
        post,
      }).title;
    expect(title({ timezone_string: "Not/AZone" })).toBe("15:04 UTC UTC");
    expect(title({ timezone_string: "Not/AZone", gmt_offset: "-3.5" })).toBe(
      "11:34 GMT-0330 -03:30",
    );
    expect(title({ timezone_string: "America/Chicago" })).toBe("09:04 CST America/Chicago");
    expect(title({})).toBe("15:04 UTC UTC");
  });

  test("a fixed offset zone has an abbreviation of its own, which PHP 8.3 spells GMT+0530", () => {
    const post = wpPost();
    const model = modelOf([post], {
      titles: { pt_post_title: "%date(H:i T P e)%" },
      options: { gmt_offset: "5.5" },
    });
    expect(seoFor(model, { kind: "post", post }).title).toBe("20:34 GMT+0530 +05:30 +05:30");
    expect(php.date("u v", 0, "UTC")).toBe("000000 000");
  });

  test("the current date and time are the moment given, in the site's zone", () => {
    const now = new Date("2026-07-04T02:30:00Z");
    const post = wpPost();
    const model = (template: string): WpModel =>
      modelOf([post], {
        titles: { pt_post_title: template },
        options: {
          timezone_string: "America/New_York",
          date_format: "F j, Y",
          time_format: "g:i a",
        },
      });
    const title = (template: string): string =>
      seoFor(model(template), { kind: "post", post }, { now }).title;
    expect(title("%currentyear% %currentmonth% %currentday%")).toBe("2026 July 3");
    expect(title("%currentdate%")).toBe("July 3, 2026");
    expect(title("%currenttime%")).toBe("10:30 pm");
    expect(title("%currenttime(H:i)%")).toBe("22:30");
    // Without a clock given, it is today.
    expect(seoFor(model("%currentyear%"), { kind: "post", post }).title).toBe(
      String(new Date().getFullYear()),
    );
  });

  test("an excerpt is the post's own, with tags stripped and shortcodes gone", () => {
    const render = (post: Partial<WpPost>): string =>
      seoOfPost(post, { titles: { pt_post_title: "%excerpt%" } }).title;
    expect(render({ excerpt: "<b>Own</b> [gallery] excerpt" })).toBe("Own excerpt");
    expect(render({ content: "<p>From content</p>" })).toBe("From content");
    expect(render({ excerpt: "0", content: "<p>Zero is not an excerpt</p>" })).toBe(
      "Zero is not an excerpt",
    );
    expect(render({ content: "[only_shortcode]" })).toBe("");
    expect(render({})).toBe("");
  });

  test("the terms' variables and an unknown variable in the real options", () => {
    const report = createReport();
    const model = models.fineline;
    for (const post of model.posts.values()) {
      if (post.type === "attachment") continue;
      seoFor(model, { kind: "post", post }, { report });
    }
    for (const term of model.terms.values()) seoFor(model, { kind: "term", term }, { report });
    seoFor(model, { kind: "home" }, { report });
    // The `%variables%` of the real templates (%sitename%, %page%, %term%, %excerpt%…) are all known: nothing is unknown.
    expect(codes(report, "seo.unknown-variable")).toEqual([]);
    const used = new Set<string>();
    for (const site of ["fineline", "ap"] as const) {
      const titles = JSON.stringify(
        [...models[site].options.get("rank-math-options-titles")!.matchAll(/%[a-z_]+%/g)].map(
          (m) => m[0],
        ),
      );
      for (const m of titles.matchAll(/%([a-z_]+)%/g)) used.add(m[1]!);
    }
    expect([...used].sort()).toEqual([
      "date",
      "excerpt",
      "name",
      "page",
      "pt_plural",
      "search_query",
      "seo_description",
      "seo_title",
      "sep",
      "sitedesc",
      "sitename",
      "term",
      "term_description",
      "title",
    ]);
  });
});

// ── Descriptions ─────────────────────────────────────────────────────────────────────────────────

describe("descriptions", () => {
  test("meta, then the excerpt, then the template (the first paragraph of the content)", () => {
    const content =
      '<!-- wp:paragraph -->\n<p>First <a href="/x">paragraph</a> here.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Second one.</p>\n<!-- /wp:paragraph -->';
    expect(seoOfPost({ content }).description).toBe("First paragraph here.");
    expect(seoOfPost({ content, excerpt: "The excerpt." }).description).toBe("The excerpt.");
    expect(
      seoOfPost(
        { content, excerpt: "The excerpt." },
        { postMeta: { rank_math_description: ["Custom."] } },
      ).description,
    ).toBe("Custom.");
    expect(seoOfPost({ content: "" }).description).toBe("");
  });

  test("the paragraph with the focus keyword comes first, a space in the keyword matching anything", () => {
    const content = "<p>Alpha opening.</p>\n\n<p>The Blue Cat sat.</p>\n\n<p>Closing.</p>";
    expect(
      seoOfPost({ content }, { postMeta: { rank_math_focus_keyword: ["blue cat"] } }).description,
    ).toBe("The Blue Cat sat.");
    expect(
      seoOfPost({ content }, { postMeta: { rank_math_focus_keyword: ["blue-cat, other"] } })
        .description,
    ).toBe("Alpha opening.");
    expect(
      seoOfPost({ content }, { postMeta: { rank_math_focus_keyword: ["blue cat"] } }, {}).openGraph
        .description,
    ).toBe("The Blue Cat sat.");
  });

  test("an automatic description is cut at 160 characters at a word, a written one is not", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const auto = seoOfPost({ content: `<p>${long}</p>` }).description;
    expect(auto.length).toBeLessThanOrEqual(160);
    expect(auto).toBe(long.slice(0, auto.length));
    expect(long.slice(auto.length, auto.length + 1)).toBe(" ");
    expect(seoOfPost({ excerpt: long }).description).toBe(long);
    expect(seoOfPost({}, { postMeta: { rank_math_description: [long] } }).description).toBe(long);
  });

  test("text, as shown: entities decoded once, tags and breaks gone", () => {
    expect(seoOfPost({ excerpt: "Fish &amp; <b>chips</b>\nand  peas" }).description).toBe(
      "Fish & chips and peas",
    );
    expect(
      seoOfPost({ content: "<p>&ldquo;Quoted&rdquo; &amp;amp; &nbsp;done</p>" }).description,
    ).toBe("“Quoted” &amp;  done");
    expect(seoOfPost({ content: "<p>A &bogus; B</p>" }).description).toBe("A &bogus; B");
  });

  test("the template for the type may be something else than the excerpt", () => {
    expect(
      seoOfPost({ title: "T" }, { titles: { pt_post_description: "About %title% on %sitename%" } })
        .description,
    ).toBe("About T on X Site");
    // `%seo_description%` is the excerpt.
    expect(
      seoOfPost(
        { content: "<p>Body</p>" },
        { titles: { pt_post_description: "%seo_description%" } },
      ).description,
    ).toBe("Body");
    expect(seoOfPost({}, { titles: { pt_post_description: "" } }).description).toBe("");
  });
});

// ── Robots ───────────────────────────────────────────────────────────────────────────────────────

describe("robots", () => {
  const ADV = "max-snippet:-1, max-video-preview:-1, max-image-preview:large";
  const robots = (
    meta: Record<string, unknown[]> = {},
    titles: Record<string, unknown> = {},
    post: Partial<WpPost> = {},
    extra: Parts = {},
  ): string => seoOfPost(post, { ...extra, titles, postMeta: meta }).robots;

  test("the default: follow first, then index, then the advanced directives", () => {
    expect(robots()).toBe(`follow, index, ${ADV}`);
  });

  test("a post's own robots, with noindex and nofollow spelled the way the plugin spells them", () => {
    expect(robots({ rank_math_robots: [["index"]] })).toBe(`follow, index, ${ADV}`);
    expect(robots({ rank_math_robots: [["noindex"]] })).toBe("follow, noindex");
    expect(robots({ rank_math_robots: [["noindex", "nofollow"]] })).toBe("nofollow, noindex");
    expect(robots({ rank_math_robots: [["index", "nofollow"]] })).toBe(`nofollow, index, ${ADV}`);
    expect(robots({ rank_math_robots: [["index", "noarchive", "nosnippet"]] })).toBe(
      "follow, index, noarchive, nosnippet",
    );
    expect(robots({ rank_math_robots: [["index", "noimageindex", "bogus"]] })).toBe(
      `follow, index, noimageindex, ${ADV}`,
    );
    expect(robots({ rank_math_robots: [["noindex", "noindex", "index"]] })).toBe("follow, noindex");
    expect(robots({ rank_math_robots: [[]] })).toBe(`follow, index, ${ADV}`);
    expect(robots({ rank_math_robots: [""] })).toBe(`follow, index, ${ADV}`);
  });

  test("a type's own robots apply only when the type has custom robots on, and without a post's own", () => {
    const titles = { pt_post_custom_robots: "on", pt_post_robots: ["noindex"] };
    expect(robots({}, titles)).toBe("follow, noindex");
    expect(robots({ rank_math_robots: [["index"]] }, titles)).toBe(`follow, index, ${ADV}`);
    expect(robots({}, { ...titles, pt_post_custom_robots: "off" })).toBe(`follow, index, ${ADV}`);
    // Custom robots with no directives set is "index, follow".
    expect(robots({}, { pt_post_custom_robots: "on", pt_post_robots: [] })).toBe(
      `index, follow, ${ADV}`,
    );
    // With the type's advanced robots unset, the site's stand in.
    expect(
      robots({}, { pt_post_custom_robots: "on", pt_post_robots: ["index", "noarchive"] }),
    ).toBe(`follow, index, noarchive, ${ADV}`);
  });

  test("the advanced directives: the post's own, the type's when custom, else the site's", () => {
    expect(
      robots({
        rank_math_advanced_robots: [{ "max-snippet": "50", "max-image-preview": "standard" }],
      }),
    ).toBe("follow, index, max-snippet:50, max-image-preview:standard");
    expect(
      robots(
        {},
        {
          pt_post_custom_robots: "on",
          pt_post_robots: ["index"],
          pt_post_advanced_robots: {
            "max-snippet": "10",
            "max-video-preview": false,
            "max-image-preview": "none",
          },
        },
      ),
    ).toBe("follow, index, max-snippet:10, max-image-preview:none");
    // Custom robots with nothing advanced set falls back to the site's.
    expect(
      robots(
        {},
        { pt_post_custom_robots: "on", pt_post_robots: ["index"], pt_post_advanced_robots: {} },
      ),
    ).toBe(`follow, index, ${ADV}`);
    expect(
      robots(
        {},
        {
          advanced_robots_global: {
            "max-snippet": "20",
            "max-video-preview": "0",
            "max-image-preview": "large",
          },
        },
      ),
    ).toBe("follow, index, max-snippet:20, max-image-preview:large");
    // All of them off: a plain index and follow.
    expect(robots({ rank_math_advanced_robots: [{ "max-snippet": false }] })).toBe("follow, index");
    // Nothing advanced is said on a noindex page, or when snippets are off.
    expect(
      robots({
        rank_math_robots: [["noindex"]],
        rank_math_advanced_robots: [{ "max-snippet": "5" }],
      }),
    ).toBe("follow, noindex");
    expect(robots({ rank_math_robots: [["index", "nosnippet"]] })).toBe("follow, index, nosnippet");
  });

  test("a private post is noindex; a password-protected one only when the site asks", () => {
    expect(robots({}, {}, { status: "private" })).toBe("follow, noindex");
    expect(robots({ rank_math_robots: [["index", "nofollow"]] }, {}, { status: "private" })).toBe(
      "nofollow, noindex",
    );
    expect(robots({}, {}, { passwordProtected: true })).toBe(`follow, index, ${ADV}`);
    expect(robots({}, { noindex_password_protected: "on" }, { passwordProtected: true })).toBe(
      "follow, noindex",
    );
    expect(robots({}, { noindex_password_protected: "off" }, { passwordProtected: true })).toBe(
      `follow, index, ${ADV}`,
    );
  });

  test("a site that is not public says noindex, nofollow everywhere", () => {
    expect(robots({}, {}, {}, { options: { blog_public: "0" } })).toBe("nofollow, noindex");
    expect(robots({}, {}, {}, { options: { blog_public: "1" } })).toBe(`follow, index, ${ADV}`);
  });

  test("without a global robots setting the answer is index, follow", () => {
    expect(robots({}, { robots_global: [] })).toBe(`index, follow, ${ADV}`);
    expect(robots({}, { robots_global: ["noindex"] })).toBe("follow, noindex");
  });

  test("a term: its own robots, the taxonomy's, and noindex when it is empty and has no children", () => {
    const term = (
      o: Partial<WpTerm>,
      titles: Record<string, unknown> = {},
      others: WpTerm[] = [],
    ): string => {
      const t = wpTerm({ termId: 50, taxonomy: "genre", slug: "jazz", name: "Jazz", ...o });
      const model = modelOf([], {
        terms: [t, ...others],
        titles: { noindex_empty_taxonomies: "on", ...titles },
      });
      return seoFor(model, { kind: "term", term: t }).robots;
    };
    expect(term({})).toBe(`follow, index, ${ADV}`);
    expect(term({ count: 0 })).toBe("follow, noindex");
    expect(term({ count: 0 }, {}, [wpTerm({ termId: 51, taxonomy: "genre", parent: 50 })])).toBe(
      `follow, index, ${ADV}`,
    );
    // A child in another taxonomy is not a child.
    expect(term({ count: 0 }, {}, [wpTerm({ termId: 51, taxonomy: "other", parent: 50 })])).toBe(
      "follow, noindex",
    );
    expect(term({ count: 0 }, { noindex_empty_taxonomies: "off" })).toBe(`follow, index, ${ADV}`);
    expect(term({ meta: { rank_math_robots: ["noindex", "nofollow"] } })).toBe("nofollow, noindex");
    expect(term({}, { tax_genre_custom_robots: "on", tax_genre_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(
      term(
        {},
        {
          tax_genre_custom_robots: "on",
          tax_genre_robots: ["index"],
          tax_genre_advanced_robots: { "max-snippet": "9" },
        },
      ),
    ).toBe("follow, index, max-snippet:9");
    expect(term({ meta: { rank_math_advanced_robots: { "max-image-preview": "none" } } })).toBe(
      "follow, index, max-image-preview:none",
    );
  });

  test("the front page that lists posts, and an archive: custom robots or none, and no advanced directives without them", () => {
    const home = (titles: Record<string, unknown>): string =>
      seoFor(modelOf([], { titles }), { kind: "home" }).robots;
    expect(home({})).toBe("follow, index");
    expect(home({ homepage_custom_robots: "on", homepage_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(
      home({
        homepage_custom_robots: "on",
        homepage_robots: ["index"],
        homepage_advanced_robots: { "max-snippet": "3" },
      }),
    ).toBe("follow, index, max-snippet:3");
    const archive = (titles: Record<string, unknown>): string =>
      seoFor(modelOf([], { titles }), { kind: "archive", postType: "book" }).robots;
    expect(archive({})).toBe("follow, index");
    expect(
      archive({
        pt_book_custom_robots: "on",
        pt_book_robots: ["index"],
        pt_book_advanced_robots: { "max-snippet": "-1", "max-image-preview": "large" },
      }),
    ).toBe("follow, index, max-snippet:-1, max-image-preview:large");
  });
});

// ── The front page, the posts page, archives, terms ──────────────────────────────────────────────

describe("the other kinds of page", () => {
  test("a site with a static front page uses the page's own SEO for home, and its own homepage templates are not used", () => {
    const front = wpPost({
      id: 10,
      type: "page",
      slug: "welcome",
      title: "Welcome",
      content: "<p>Hello visitors.</p>",
    });
    const blog = wpPost({ id: 11, type: "page", slug: "news", title: "News" });
    const model = modelOf([front, blog], {
      site: { showOnFront: "page", pageOnFront: 10, pageForPosts: 11 },
      titles: {
        homepage_title: "HOME %sitename%",
        pt_page_title: "%title% / %sitename%",
        pt_page_description: "%excerpt%",
      },
    });
    expect(seoFor(model, { kind: "home" })).toMatchObject({
      title: "Welcome / X Site",
      description: "Hello visitors.",
      openGraph: { type: "website" },
    });
    expect(seoFor(model, { kind: "posts-page" })).toMatchObject({
      title: "News / X Site",
      description: "",
      openGraph: { type: "website" },
    });
    expect(seoFor(model, { kind: "post", post: front }).openGraph.type).toBe("article");
  });

  test("a site that shows its latest posts uses the homepage templates, for home and for the posts page", () => {
    const model = modelOf([], {
      titles: {
        homepage_title: "%sitename% %page% %sep% %sitedesc%",
        homepage_description: "Welcome to %sitename%",
      },
    });
    expect(seoFor(model, { kind: "home" })).toMatchObject({
      title: "X Site - A tagline",
      description: "Welcome to X Site",
      openGraph: { type: "website", title: "X Site - A tagline" },
    });
    expect(seoFor(model, { kind: "posts-page" }).title).toBe("X Site - A tagline");
    // With no description template the tagline is the description.
    expect(
      seoFor(modelOf([], { titles: { homepage_title: "%sitename%" } }), { kind: "home" })
        .description,
    ).toBe("A tagline");
  });

  test("the homepage's own social title, description and image", () => {
    const model = modelOf([], {
      titles: {
        homepage_title: "T",
        homepage_facebook_title: "Social %sitename%",
        homepage_facebook_description: "Social description",
        homepage_facebook_image_id: "20",
      },
      attachments: [
        wpAttachment({
          id: 20,
          file: "home.png",
          mime: "image/png",
          url: "https://x.test/wp-content/uploads/home.png",
          width: 1200,
          height: 630,
        }),
      ],
    });
    const seo = seoFor(model, { kind: "home" });
    expect(seo.title).toBe("T");
    expect(seo.openGraph).toMatchObject({
      title: "Social X Site",
      description: "Social description",
      image: {
        id: 20,
        url: "https://x.test/wp-content/uploads/home.png",
        width: 1200,
        height: 630,
      },
    });
    expect(seo.image?.id).toBe(20);
    expect(seo.twitter.image?.id).toBe(20);
  });

  test("a front or posts page that is not in the model is reported, and the homepage templates stand in", () => {
    const report = createReport();
    const model = modelOf([], {
      site: { showOnFront: "page", pageOnFront: 10, pageForPosts: 11 },
      titles: { homepage_title: "Home %sitename%" },
    });
    expect(seoFor(model, { kind: "home" }, { report }).title).toBe("Home X Site");
    expect(seoFor(model, { kind: "posts-page" }, { report }).title).toBe("Home X Site");
    const missing = codes(report, "seo.target-missing");
    expect(missing.map((e) => e.where)).toEqual(["option:page_on_front", "option:page_for_posts"]);
    expect(missing[0]!.message).toContain("front page (10)");
  });

  test("a post type's archive: the plural name, and the default template when there is none", () => {
    const model = modelOf([], {
      titles: {
        pt_book_archive_title: "%title% %page% %sep% %sitename%",
        pt_movie_archive_title: "",
      },
    });
    // Without an ACF definition the type's own name is its label.
    expect(seoFor(model, { kind: "archive", postType: "book" }).title).toBe("book - X Site");
    // With no template at all the plugin's default is "%pt_plural% Archive %page% %sep% %sitename%".
    expect(seoFor(model, { kind: "archive", postType: "movie" }).title).toBe(
      "movie Archive - X Site",
    );
    expect(seoFor(model, { kind: "archive", postType: "movie" }).description).toBe(
      "movie Archive - X Site",
    );
    expect(seoFor(model, { kind: "archive", postType: "post" }).title).toBe(
      "Posts Archive - X Site",
    );
  });

  test("a post type that ACF defines is named by its own labels", () => {
    const def = wpPost({
      id: 70,
      type: "acf-post-type",
      slug: "post_type_x",
      title: "Projects",
      content: serialize({
        post_type: "project",
        labels: { name: "Projects", singular_name: "Project" },
      }),
    });
    const project = wpPost({ id: 71, type: "project", slug: "p", title: "P" });
    const model = modelOf([def, project], {
      titles: {
        pt_project_title: "%pt_single% / %pt_plural% / %title%",
        pt_project_archive_title: "All %pt_plural%",
      },
    });
    expect(seoFor(model, { kind: "post", post: project }).title).toBe("Project / Projects / P");
    expect(seoFor(model, { kind: "archive", postType: "project" }).title).toBe("All Projects");
  });

  test("a term: the template for its taxonomy, its own meta first, and the term's name and description", () => {
    const term = wpTerm({
      termId: 60,
      taxonomy: "genre",
      slug: "jazz",
      name: "Jazz &amp; Blues",
      description: "<p>Music &amp; more</p>",
    });
    const model = modelOf([], {
      terms: [term],
      titles: {
        tax_genre_title: "%term% Archives %page% %sep% %sitename%",
        tax_genre_description: "%term_description%",
      },
    });
    expect(seoFor(model, { kind: "term", term })).toMatchObject({
      title: "Jazz & Blues Archives - X Site",
      description: "Music & more",
      openGraph: { type: "article" },
    });
    const own = {
      ...term,
      meta: {
        rank_math_title: "Own %term%",
        rank_math_description: "Own description",
        rank_math_canonical_url: "https://elsewhere.test/jazz/",
      },
    };
    const model2 = modelOf([], { terms: [own] });
    expect(seoFor(model2, { kind: "term", term: own })).toMatchObject({
      title: "Own Jazz & Blues",
      description: "Own description",
      canonical: "https://elsewhere.test/jazz/",
    });
  });
});

// ── Social ───────────────────────────────────────────────────────────────────────────────────────

describe("Open Graph and Twitter", () => {
  test("the page's own social title and description, and Twitter's, in the order the plugin picks them", () => {
    const meta = {
      rank_math_facebook_title: ["FB %title%"],
      rank_math_facebook_description: ["FB description"],
      rank_math_twitter_title: ["TW title"],
      rank_math_twitter_description: ["TW description"],
    };
    const seo = seoOfPost({ title: "Post" }, { postMeta: meta });
    expect(seo.title).toBe("Post - X Site");
    expect(seo.openGraph).toMatchObject({
      title: "FB Post",
      description: "FB description",
      siteName: "X Site",
      locale: "en_US",
      type: "article",
    });
    expect(seo.twitter).toMatchObject({ title: "TW title", description: "TW description" });
    // Twitter can use the Facebook ones.
    const same = seoOfPost(
      { title: "Post" },
      { postMeta: { ...meta, rank_math_twitter_use_facebook: ["on"] } },
    );
    expect(same.twitter).toMatchObject({ title: "FB Post", description: "FB description" });
    // With none, the page's own title and description.
    expect(seoOfPost({ title: "Post", excerpt: "Ex." }).twitter).toMatchObject({
      title: "Post - X Site",
      description: "Ex.",
    });
    expect(seoOfPost({ title: "Post", excerpt: "Ex." }).openGraph.description).toBe("Ex.");
  });

  test("capitalised social titles, the site's name, locale and Twitter handle and card", () => {
    const seo = seoOfPost(
      { title: "post" },
      {
        titles: {
          capitalize_titles: "on",
          website_name: "Brand &amp; Co",
          twitter_author_names: "brand",
          twitter_card_type: "summary",
        },
        postMeta: { rank_math_facebook_title: ["a social title"] },
        site: { language: "de-DE" },
      },
    );
    expect(seo.openGraph).toMatchObject({
      title: "A Social Title",
      siteName: "Brand & Co",
      locale: "de_DE",
    });
    expect(seo.twitter).toMatchObject({ card: "summary", site: "@brand" });
    expect(seoOfPost({}, { titles: { twitter_card_type: "nonsense" } }).twitter.card).toBe(
      "summary",
    );
    expect(
      seoOfPost(
        {},
        {
          titles: { twitter_card_type: "summary_large_image" },
          postMeta: { rank_math_twitter_card_type: ["player"] },
        },
      ).twitter.card,
    ).toBe("player");
    expect(seoOfPost({}).twitter.site).toBeUndefined();
  });

  test("the canonical: a person's override, else the address the caller says the object has; none on a noindex page", () => {
    const own = seoOfPost(
      {},
      { postMeta: { rank_math_canonical_url: ["https://elsewhere.test/a/"] } },
      { permalink: () => "https://x.test/a-post/" },
    );
    expect(own.canonical).toBe("https://elsewhere.test/a/");
    expect(own.openGraph.url).toBe("https://elsewhere.test/a/");
    const seen: SeoTarget[] = [];
    const given = seoOfPost(
      {},
      {},
      {
        permalink: (t) => {
          seen.push(t);
          return "https://x.test/a-post/";
        },
      },
    );
    expect(given.canonical).toBe("https://x.test/a-post/");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "post" });
    // Nothing known: no canonical rather than a guess.
    expect(seoOfPost({}).canonical).toBeUndefined();
    expect(seoOfPost({}).openGraph.url).toBeUndefined();
    // A noindex page prints none.
    expect(
      seoOfPost(
        {},
        { postMeta: { rank_math_robots: [["noindex"]] } },
        { permalink: () => "https://x.test/a-post/" },
      ).canonical,
    ).toBeUndefined();
    // The permalink of a term and of the front page.
    const term = wpTerm({ termId: 3, taxonomy: "genre" });
    const model = modelOf([], { terms: [term] });
    const targets: SeoTarget[] = [];
    seoFor(
      model,
      { kind: "term", term },
      {
        permalink: (t) => {
          targets.push(t);
          return "u";
        },
      },
    );
    seoFor(
      model,
      { kind: "home" },
      {
        permalink: (t) => {
          targets.push(t);
          return "u";
        },
      },
    );
    expect(targets.map((t) => t.kind)).toEqual(["term", "home"]);
  });

  test("%url% is the permalink the caller gives, or nothing", () => {
    expect(
      seoOfPost(
        {},
        { titles: { pt_post_title: "[%url%]" } },
        { permalink: () => "https://x.test/p/" },
      ).title,
    ).toBe("[https://x.test/p/]");
    expect(seoOfPost({}, { titles: { pt_post_title: "[%url%]" } }).title).toBe("[]");
  });
});

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

describe("the social image", () => {
  const sizes = (...names: [string, number, number][]): WpAttachment["sizes"] =>
    names.map(([name, width, height]) => ({
      name,
      file: `pic-${width}x${height}.jpg`,
      width,
      height,
    }));
  const att = (o: Partial<WpAttachment> & { id: number }): WpAttachment =>
    wpAttachment({ file: "pic.jpg", url: "https://x.test/wp-content/uploads/pic.jpg", ...o });
  const image = (
    attachments: WpAttachment[],
    meta: Record<string, unknown[]>,
    post: Partial<WpPost> = {},
    parts: Parts = {},
  ): Seo["image"] => seoOfPost(post, { ...parts, attachments, postMeta: meta }).image;

  test("the featured image, at the first of full, large and medium_large that is between 200 and 2000 pixels each way", () => {
    const big = att({
      id: 1,
      width: 3000,
      height: 2000,
      sizes: sizes(["large", 1024, 683], ["medium_large", 768, 512]),
    });
    expect(image([big], { _thumbnail_id: ["1"] })).toMatchObject({
      id: 1,
      url: "https://x.test/wp-content/uploads/pic-1024x683.jpg",
      width: 1024,
      height: 683,
      type: "image/jpeg",
    });
    const fits = att({ id: 2, width: 1600, height: 900, sizes: sizes(["large", 1024, 576]) });
    expect(image([fits], { _thumbnail_id: ["2"] })).toMatchObject({
      url: "https://x.test/wp-content/uploads/pic.jpg",
      width: 1600,
      height: 900,
    });
    // Exactly 2000 is usable, 2001 is not.
    expect(
      image([att({ id: 3, width: 2000, height: 2000 })], { _thumbnail_id: ["3"] }),
    ).toMatchObject({ width: 2000 });
    expect(
      image([att({ id: 3, width: 2001, height: 1000 })], { _thumbnail_id: ["3"] }),
    ).toMatchObject({ width: 1024, height: 512, url: "https://x.test/wp-content/uploads/pic.jpg" });
    // Too small in either direction, and nothing else usable: no image.
    expect(
      image([att({ id: 4, width: 199, height: 800 })], { _thumbnail_id: ["4"] }),
    ).toBeUndefined();
    expect(
      image([att({ id: 4, width: 800, height: 199 })], { _thumbnail_id: ["4"] }),
    ).toBeUndefined();
    // Medium_large, when it is the one that fits.
    expect(
      image(
        [
          att({
            id: 5,
            width: 5000,
            height: 4000,
            sizes: sizes(["large", 1024, 819], ["medium_large", 768, 614]),
          }),
        ],
        { _thumbnail_id: ["5"] },
      ),
    ).toMatchObject({ width: 1024 });
  });

  test("a large size that does not exist is the full file with the size's dimensions", () => {
    // 2400 x 1600 has no `large` copy: WordPress answers the full file, scaled to fit 1024 x 1024 on paper.
    expect(
      image([att({ id: 1, width: 2400, height: 1600 })], { _thumbnail_id: ["1"] }),
    ).toMatchObject({ url: "https://x.test/wp-content/uploads/pic.jpg", width: 1024, height: 683 });
    // The site can set the size.
    expect(
      image(
        [att({ id: 1, width: 2400, height: 1600 })],
        { _thumbnail_id: ["1"] },
        {},
        { options: { large_size_w: "800", large_size_h: "800" } },
      ),
    ).toMatchObject({ width: 800, height: 533 });
    // With no dimensions at all there is nothing to judge: no image.
    expect(image([att({ id: 6 })], { _thumbnail_id: ["6"] })).toBeUndefined();
  });

  test("the image of the page's own social setting comes before the featured image", () => {
    const a = att({
      id: 1,
      file: "own.jpg",
      url: "https://x.test/wp-content/uploads/own.jpg",
      width: 800,
      height: 600,
    });
    const b = att({
      id: 2,
      file: "feat.jpg",
      url: "https://x.test/wp-content/uploads/feat.jpg",
      width: 800,
      height: 600,
    });
    expect(image([a, b], { _thumbnail_id: ["2"], rank_math_facebook_image_id: ["1"] })?.id).toBe(1);
    expect(image([a, b], { _thumbnail_id: ["2"] })?.id).toBe(2);
    // Twitter's own image id, and Facebook's when it uses it.
    const both = seoOfPost(
      {},
      {
        attachments: [a, b],
        postMeta: {
          _thumbnail_id: ["2"],
          rank_math_facebook_image_id: ["1"],
          rank_math_twitter_image_id: ["2"],
        },
      },
    );
    expect([both.image?.id, both.twitter.image?.id]).toEqual([1, 2]);
    const shared = seoOfPost(
      {},
      {
        attachments: [a, b],
        postMeta: {
          rank_math_facebook_image_id: ["1"],
          rank_math_twitter_image_id: ["2"],
          rank_math_twitter_use_facebook: ["on"],
        },
      },
    );
    expect(shared.twitter.image?.id).toBe(1);
  });

  test("an image that is not an image, or not a usable type, is skipped", () => {
    const svg = att({
      id: 1,
      file: "logo.svg",
      mime: "image/svg+xml",
      url: "https://x.test/wp-content/uploads/logo.svg",
      width: 800,
      height: 800,
    });
    const pdf = att({
      id: 2,
      file: "doc.pdf",
      mime: "application/pdf",
      url: "https://x.test/wp-content/uploads/doc.pdf",
      width: 800,
      height: 800,
    });
    const webp = att({
      id: 3,
      file: "p.webp",
      mime: "image/webp",
      url: "https://x.test/wp-content/uploads/p.webp",
      width: 800,
      height: 800,
    });
    const bmp = att({
      id: 4,
      file: "p.bmp",
      mime: "image/bmp",
      url: "https://x.test/wp-content/uploads/p.bmp",
      width: 800,
      height: 800,
    });
    expect(image([svg], { _thumbnail_id: ["1"] })).toBeUndefined();
    expect(image([pdf], { _thumbnail_id: ["2"] })).toBeUndefined();
    expect(image([webp], { _thumbnail_id: ["3"] })?.type).toBe("image/webp");
    expect(image([bmp], { _thumbnail_id: ["4"] })).toBeUndefined();
    // The next choice stands in for the one that was no use: the first usable image in the content.
    const ok = att({
      id: 5,
      file: "ok.jpg",
      url: "https://x.test/wp-content/uploads/ok.jpg",
      width: 800,
      height: 600,
    });
    expect(
      image(
        [svg, ok],
        { _thumbnail_id: ["1"] },
        { content: '<img src="https://x.test/wp-content/uploads/ok.jpg">' },
      )?.id,
    ).toBe(5);
  });

  test("a meta row that points at an attachment which is not there is reported, and the next choice is used", () => {
    const report = createReport();
    const ok = att({
      id: 5,
      file: "ok.jpg",
      url: "https://x.test/wp-content/uploads/ok.jpg",
      width: 800,
      height: 600,
    });
    const seo = seoOfPost(
      {},
      {
        attachments: [ok],
        postMeta: { rank_math_facebook_image_id: ["404"], _thumbnail_id: ["5"] },
      },
      { report },
    );
    expect(seo.image?.id).toBe(5);
    const entries = codes(report, "seo.image-unresolved");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      data: { attachment: 404 },
      url: expect.stringContaining("?p="),
    });
    expect(entries[0]!.message).toContain("facebook image");
    // An existing attachment that is no use is not a missing one.
    const quiet = createReport();
    seoOfPost(
      {},
      { attachments: [att({ id: 6, width: 10, height: 10 })], postMeta: { _thumbnail_id: ["6"] } },
      { report: quiet },
    );
    expect(codes(quiet, "seo.image-unresolved")).toEqual([]);
  });

  test("the image of the content: the first usable <img>, from the plugin's own cache while it is current, else from the content", () => {
    const small = att({
      id: 1,
      file: "small.png",
      mime: "image/png",
      url: "https://x.test/wp-content/uploads/small.png",
      width: 50,
      height: 50,
    });
    const good = att({
      id: 2,
      file: "good.png",
      mime: "image/png",
      url: "https://x.test/wp-content/uploads/good.png",
      width: 640,
      height: 480,
      sizes: sizes(["medium_large", 640, 480]),
    });
    const content =
      '<p>x</p><img class="a" src="https://x.test/wp-content/uploads/small.png"><img src="https://x.test/wp-content/uploads/good-300x225.png?x=1"><img src="https://x.test/wp-content/uploads/good.png">';
    expect(image([small, good], {}, { content })?.id).toBe(2);
    // The cache, while the content's md5 is the same: its list is used as it is.
    const check = md5(content);
    expect(
      image([small, good], { rank_math_og_content_image: [{ check, images: [2] }] }, { content })
        ?.id,
    ).toBe(2);
    // A cache of another content is not trusted.
    expect(
      image(
        [small, good],
        { rank_math_og_content_image: [{ check: "stale", images: [1] }] },
        { content },
      )?.id,
    ).toBe(2);
    // A cached address that is not a media file stands as it is; so does an external image.
    expect(
      image(
        [],
        {
          rank_math_og_content_image: [
            { check: md5("<img>"), images: ["https://cdn.test/a.webp?v=1"] },
          ],
        },
        { content: "<img>" },
      ),
    ).toEqual({ url: "https://cdn.test/a.webp", alt: "A Post" });
    expect(image([], {}, { content: '<img src="https://cdn.test/b.jpg">' })).toEqual({
      url: "https://cdn.test/b.jpg",
      alt: "A Post",
    });
    expect(image([], {}, { content: '<img src="https://cdn.test/b.svg">' })).toBeUndefined();
    // A relative address is this site's.
    expect(image([], {}, { content: '<img src="/wp-content/uploads/none.jpg">' })).toEqual({
      url: "https://x.test/wp-content/uploads/none.jpg",
      alt: "A Post",
    });
    // An address that is not an address is not a media-library file, and not an image either.
    expect(image([good], {}, { content: '<img src="http://[bad">' })).toBeUndefined();
    // Images without a source, and posts without images.
    expect(image([good], {}, { content: "<img alt='x'>" })).toBeUndefined();
    expect(image([good], {}, { content: "<p>no image</p>" })).toBeUndefined();
    expect(image([good], {}, { content: "" })).toBeUndefined();
  });

  test("a media host that serves the files from its root names the attachment by its own address", () => {
    const media = att({
      id: 1,
      file: "pic.png",
      mime: "image/png",
      url: "https://media.x.test/pic.png",
      width: 800,
      height: 600,
    });
    expect(image([media], {}, { content: '<img src="https://media.x.test/pic.png">' })?.url).toBe(
      "https://media.x.test/pic.png",
    );
    // A file the offload plugin keeps at a bucket address is that address, whatever the site's uploads folder is.
    const bucket = att({
      id: 2,
      file: "https://bucket.test/uploads/pic.png",
      url: "https://x.test/?attachment_id=2",
      mime: "image/png",
      width: 800,
      height: 600,
    });
    expect(image([bucket], { _thumbnail_id: ["2"] })?.url).toBe(
      "https://bucket.test/uploads/pic.png",
    );
    // A guid that is not where the file is (an attachment page address) falls back to the uploads folder.
    const odd = att({
      id: 3,
      file: "2024/05/odd.jpg",
      url: "https://x.test/odd-page/",
      width: 800,
      height: 600,
    });
    expect(image([odd], { _thumbnail_id: ["3"] })?.url).toBe(
      "https://x.test/wp-content/uploads/2024/05/odd.jpg",
    );
  });

  test("the alt text: the attachment's own, else the focus keyword, else the title; none on the posts page", () => {
    const a = att({ id: 1, width: 800, height: 600, alt: "Own alt" });
    const b = att({
      id: 2,
      file: "b.jpg",
      url: "https://x.test/wp-content/uploads/b.jpg",
      width: 800,
      height: 600,
    });
    expect(image([a], { _thumbnail_id: ["1"] })?.alt).toBe("Own alt");
    expect(
      image([b], { _thumbnail_id: ["2"], rank_math_focus_keyword: ["house painting, other"] })?.alt,
    ).toBe("house painting");
    expect(image([b], { _thumbnail_id: ["2"] }, { title: "Fish &amp; Chips" })?.alt).toBe(
      "Fish & Chips",
    );
    const blog = wpPost({ id: 80, type: "page", slug: "blog", title: "Blog" });
    const model = modelOf([blog], {
      site: { showOnFront: "page", pageForPosts: 80, pageOnFront: 0 },
      attachments: [b],
      meta: { 80: { _thumbnail_id: ["2"] } },
    });
    expect(seoFor(model, { kind: "posts-page" }).image?.alt).toBeUndefined();
  });

  test("the site's default image, last", () => {
    const d = att({
      id: 9,
      file: "default.jpg",
      url: "https://x.test/wp-content/uploads/default.jpg",
      width: 800,
      height: 600,
    });
    expect(image([d], {}, {}, { titles: { open_graph_image_id: "9" } })?.id).toBe(9);
    expect(image([d], {}, {}, { titles: { open_graph_image_id: 0 } })).toBeUndefined();
    const post = att({
      id: 8,
      file: "post.jpg",
      url: "https://x.test/wp-content/uploads/post.jpg",
      width: 800,
      height: 600,
    });
    expect(
      image([d, post], { _thumbnail_id: ["8"] }, {}, { titles: { open_graph_image_id: "9" } })?.id,
    ).toBe(8);
    // A term: its own social image, then the default.
    const term = wpTerm({ termId: 1, meta: { rank_math_facebook_image_id: "8" } });
    const model = modelOf([], {
      terms: [term],
      attachments: [d, post],
      titles: { open_graph_image_id: "9" },
    });
    expect(seoFor(model, { kind: "term", term }).image?.id).toBe(8);
    const plain = wpTerm({ termId: 2 });
    expect(
      seoFor(
        modelOf([], { terms: [plain], attachments: [d], titles: { open_graph_image_id: "9" } }),
        { kind: "term", term: plain },
      ).image?.id,
    ).toBe(9);
    // An archive: its type's image, then the default.
    const archive = modelOf([], {
      attachments: [d, post],
      titles: { pt_book_facebook_image_id: "8", open_graph_image_id: "9" },
    });
    expect(seoFor(archive, { kind: "archive", postType: "book" }).image?.id).toBe(8);
    expect(seoFor(archive, { kind: "archive", postType: "film" }).image?.id).toBe(9);
    // A homepage that lists posts, with neither.
    expect(
      seoFor(modelOf([], { attachments: [d], titles: { open_graph_image_id: "9" } }), {
        kind: "home",
      }).image?.id,
    ).toBe(9);
  });

  test("a front page uses the featured image of the page, and then the homepage's own image", () => {
    const featured = att({
      id: 1,
      file: "f.jpg",
      url: "https://x.test/wp-content/uploads/f.jpg",
      width: 800,
      height: 600,
    });
    const homeImg = att({
      id: 2,
      file: "h.jpg",
      url: "https://x.test/wp-content/uploads/h.jpg",
      width: 800,
      height: 600,
    });
    const front = wpPost({ id: 10, type: "page", slug: "front", title: "Front" });
    const site = { showOnFront: "page" as const, pageOnFront: 10, pageForPosts: 0 };
    const withThumb = modelOf([front], {
      site,
      attachments: [featured, homeImg],
      meta: { 10: { _thumbnail_id: ["1"] } },
      titles: { homepage_facebook_image_id: "2" },
    });
    expect(seoFor(withThumb, { kind: "home" }).image?.id).toBe(1);
    const without = modelOf([front], {
      site,
      attachments: [featured, homeImg],
      titles: { homepage_facebook_image_id: "2" },
    });
    expect(seoFor(without, { kind: "home" }).image?.id).toBe(2);
    // The same page asked for as a post is not "the home": the homepage image is not its fallback.
    expect(seoFor(without, { kind: "post", post: front }).image).toBeUndefined();
  });
});

// ── What is said about what is not carried over ──────────────────────────────────────────────────

describe("the report", () => {
  test("structured data and the like are reported once per site and report, only for a site that runs Rank Math", () => {
    const post = wpPost();
    const model = modelOf([post]);
    const report = createReport();
    seoFor(model, { kind: "post", post }, { report });
    seoFor(model, { kind: "post", post }, { report });
    seoFor(model, { kind: "home" }, { report });
    const entries = codes(report, "seo.schema-not-migrated");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "info",
      where: "option:rank-math-options-titles",
    });
    // A second report hears it again.
    const other = createReport();
    seoFor(model, { kind: "post", post }, { report: other });
    expect(codes(other, "seo.schema-not-migrated")).toHaveLength(1);
    // A site that does not run Rank Math has no structured data to lose.
    const plain = modelOf([post], { site: { activePlugins: [] } });
    const quiet = createReport();
    seoFor(plain, { kind: "post", post }, { report: quiet });
    expect(codes(quiet, "seo.schema-not-migrated")).toEqual([]);
  });

  test("Rank Math is active but its options are not in the model", () => {
    const post = wpPost({ title: "T" });
    const model = modelOf([post], { noTitles: true });
    const report = createReport();
    // Rank Math's own defaults stand in: `%title% %sep% %sitename%` with no separator is just the two names.
    expect(seoFor(model, { kind: "post", post }, { report }).title).toBe("T X Site");
    seoFor(model, { kind: "post", post }, { report });
    const entries = codes(report, "seo.settings-missing");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      severity: "warn",
      where: "option:rank-math-options-titles",
    });
    // A site that does not run Rank Math says nothing about it.
    const plain = modelOf([post], { site: { activePlugins: [] }, noTitles: true });
    const quiet = createReport();
    seoFor(plain, { kind: "post", post }, { report: quiet });
    expect(codes(quiet, "seo.settings-missing")).toEqual([]);
  });

  test("a template that uses an unknown variable is reported with the post, and once for each place it is found", () => {
    const report = createReport();
    const post = wpPost({ title: "T" });
    const model = modelOf([post], {
      titles: { pt_post_title: "%title% %brand% %sep% %sitename%" },
    });
    expect(seoFor(model, { kind: "post", post }, { report }).title).toBe("T - X Site");
    const found = codes(report, "seo.unknown-variable");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      where: `post:${post.id}`,
      url: `https://x.test/?p=${post.id}`,
      data: { variable: "brand" },
    });
  });

  test("a draft has no public address to report", () => {
    const report = createReport();
    const post = wpPost({ status: "draft" });
    seoFor(
      modelOf([post], { titles: { pt_post_title: "%nope%" } }),
      { kind: "post", post },
      { report },
    );
    expect(codes(report, "seo.unknown-variable")[0]!.url).toBeUndefined();
  });
});

// <batch1>

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

describe("settings, as Rank Math stores and reads them", () => {
  const title = (settings: Record<string, unknown>): string =>
    seoOfPost({ title: "a quiet post" }, { titles: settings }).title;

  test("a switch is on for `on`, `true` and `1`, and off for `off`, `false` and `0`", () => {
    for (const on of ["on", "true", "1", 1, true])
      expect(title({ capitalize_titles: on })).toBe("A Quiet Post - X Site");
    for (const off of ["off", "false", "0", 0, false, "", []])
      expect(title({ capitalize_titles: off })).toBe("a quiet post - X Site");
  });

  test("a nested setting is read the same way (the robots lists are arrays of strings)", () => {
    const robots = (settings: Record<string, unknown>): string =>
      seoOfPost({}, { titles: settings }).robots;
    expect(robots({ robots_global: ["noindex"] })).toBe("follow, noindex");
    expect(robots({ robots_global: ["index", "nofollow"] })).toBe(
      "nofollow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
    );
    // Rank Math's `0` and `1` strings are numbers once they are read.
    expect(robots({ advanced_robots_global: { "max-snippet": "0" } })).toBe(
      "follow, index, max-video-preview:-1, max-image-preview:large",
    );
    expect(robots({ advanced_robots_global: { "max-snippet": "1" } })).toBe(
      "follow, index, max-snippet:1, max-video-preview:-1, max-image-preview:large",
    );
  });

  test("the separator, the site name and the organisation come from the settings, and an emptied setting stays empty", () => {
    const render = (template: string, settings: Record<string, unknown> = {}): string =>
      seoOfPost({ title: "T" }, { titles: { pt_post_title: template, ...settings } }).title;
    expect(render("%sep%", { title_separator: "&raquo;" })).toBe("»");
    expect(render("%sep%", { title_separator: "&" })).toBe("&");
    expect(render("%sep%", { title_separator: '"' })).toBe('"');
    expect(render("[%sep%]", { title_separator: "<" })).toBe("[<]");
    expect(render("%org_name%")).toBe("X Site");
    expect(render("%org_name%", { knowledgegraph_name: "Acme &amp; Co" })).toBe("Acme & Co");
    // A key that is there and empty is not the default: that is how Rank Math's `Settings::get` reads it.
    expect(render("[%org_name%]", { knowledgegraph_name: "" })).toBe("[]");
    expect(render("%org_url%")).toBe("https://x.test");
    expect(render("%org_url%", { url: "https://acme.test" })).toBe("https://acme.test");
    expect(render("[%org_url%]", { url: "" })).toBe("[]");
    expect(render("%org_logo%", { knowledgegraph_logo: "https://x.test/logo.png" })).toBe(
      "https://x.test/logo.png",
    );
    expect(render("[%org_logo%]")).toBe("[]");
  });
});

// ── Template variables ───────────────────────────────────────────────────────────────────────────

describe("the variables of a post", () => {
  const author: WpUser = { id: 7, slug: "ann", displayName: "Ann Author" };
  const cats = [
    wpTerm({
      termId: 1,
      taxonomy: "category",
      name: "Zebra",
      slug: "zebra",
      description: "Stripes",
    }),
    wpTerm({ termId: 2, taxonomy: "category", name: "Apple", slug: "apple", description: "Fruit" }),
    wpTerm({ termId: 3, taxonomy: "category", name: "Mango", slug: "mango" }),
    wpTerm({ termId: 4, taxonomy: "post_tag", name: "Beta", slug: "beta" }),
    wpTerm({ termId: 5, taxonomy: "post_tag", name: "Alpha", slug: "alpha" }),
    wpTerm({ termId: 6, taxonomy: "genre", name: "Jazz", slug: "jazz", description: "Cool" }),
  ];
  /** The title a template makes for a post that has every kind of data. */
  const render = (
    template: string,
    post: Partial<WpPost> = {},
    parts: Parts & { postMeta?: Record<string, unknown[]> } = {},
    opts: Parameters<typeof seoFor>[2] = {},
  ): string => {
    const p = wpPost({ id: 900, authorId: 7, ...post });
    const model = modelOf([p, wpPost({ id: 899, title: "Parent Page", type: "page" })], {
      users: [author],
      terms: cats,
      rel: { 900: [1, 2, 3, 4, 5, 6] },
      ...parts,
      titles: { [`pt_${post.type ?? "post"}_title`]: template, ...parts.titles },
      meta: { 900: parts.postMeta ?? {} },
    });
    return seoFor(model, { kind: "post", post: p }, opts).title;
  };

  test("the post's own fields", () => {
    expect(render("%id%")).toBe("900");
    expect(render("%userid%")).toBe("7");
    expect(render("[%userid%]", { authorId: 0 })).toBe("[]");
    expect(render("%name%")).toBe("Ann Author");
    expect(render("%post_author%")).toBe("Ann Author");
    expect(render("[%name%]", { authorId: 8 })).toBe("[]");
    expect(render("[%post_author%]", { authorId: 8 })).toBe("[]");
    expect(render("[%user_description%]")).toBe("[]");
    expect(render("%title%", { title: "Fish \\'n\\' Chips" })).toBe("Fish 'n' Chips");
    expect(render("[%title%]", { title: "" })).toBe("[]");
    expect(render("%pt_single% %pt_plural%")).toBe("Post Posts");
    expect(render("%pt_single% %pt_plural%", { type: "page" })).toBe("Page Pages");
    expect(render("%pt_single% %pt_plural%", { type: "attachment" })).toBe("Media Media");
    expect(render("%pt_single% %pt_plural%", { type: "event" })).toBe("event event");
    expect(render("%parent_title%", { parent: 899 })).toBe("Parent Page");
    expect(render("[%parent_title%]", { parent: 898 })).toBe("[]");
    expect(render("[%parent_title%]")).toBe("[]");
    expect(render("[%filename%] [%search_query%] [%page%] [%pagenumber%]")).toBe("[] [] [] [1]");
    expect(render("%count(x)%")).toBe("1");
  });

  test("the pages a post is in", () => {
    expect(render("%pagetotal%")).toBe("1");
    expect(render("%pagetotal%", { content: "a<!--nextpage-->b<!--nextpage-->c" })).toBe("3");
  });

  test("the excerpt and what it is made of", () => {
    expect(render("%excerpt%", { excerpt: "<b>Own</b> excerpt", content: "<p>Body</p>" })).toBe(
      "Own excerpt",
    );
    expect(render("%excerpt%", { content: "<p>First.</p><p>Second.</p>" })).toBe("First.");
    expect(render("[%excerpt%]", { excerpt: "0", content: "" })).toBe("[]");
    // The excerpt that was written is the only one `%excerpt_only%` knows.
    expect(render("%excerpt_only%", { excerpt: "<i>Own</i>", content: "<p>Body</p>" })).toBe("Own");
    expect(render("[%excerpt_only%]", { content: "<p>Body</p>" })).toBe("[]");
    expect(render("[%excerpt_only%]", { excerpt: "Own", passwordProtected: true })).toBe("[]");
    // The focus keyword picks the paragraph.
    expect(
      render(
        "%excerpt%",
        { content: "<p>First.</p><p>Has the needle here.</p>" },
        { postMeta: { rank_math_focus_keyword: ["needle,other"] } },
      ),
    ).toBe("Has the needle here.");
    expect(
      render("%focuskw% / %keywords%", {}, { postMeta: { rank_math_focus_keyword: ["one, two"] } }),
    ).toBe("one / one, two");
    expect(render("[%focuskw%] [%keywords%]")).toBe("[] []");
  });

  test("dates, in the site's time zone, with the site's formats", () => {
    const post = { date: "2024-03-05T23:30:00.000Z", modified: "2024-04-01T01:02:03.000Z" };
    expect(render("%date%", post)).toBe("March 5, 2024");
    expect(render("%date(Y-m-d)%", post)).toBe("2024-03-05");
    expect(render("%modified(Y-m-d H:i)%", post)).toBe("2024-04-01 01:02");
    expect(render("%date(jS F Y)%", post, { options: { timezone_string: "Asia/Tokyo" } })).toBe(
      "6th March 2024",
    );
    expect(render("%date%", post, { options: { date_format: "d/m/Y" } })).toBe("05/03/2024");
    // Rank Math answers whichever of the two is later.
    expect(
      render("%modified(Y-m-d)%", {
        date: "2024-05-01T00:00:00.000Z",
        modified: "2024-04-01T00:00:00.000Z",
      }),
    ).toBe("2024-05-01");
    expect(
      render("%modified(Y-m-d)%", {
        date: "2024-04-01T00:00:00.000Z",
        modified: "2024-04-01T00:00:00.000Z",
      }),
    ).toBe("2024-04-01");
    expect(render("[%date%]", { date: "not a date" })).toBe("[]");
    expect(render("[%modified%]", { modified: "not a date" })).toBe("[]");
  });

  test("the current time is the one the caller says, in the site's format", () => {
    const now = new Date("2026-10-02T14:05:09Z");
    const at = (template: string, options: Record<string, string> = {}): string =>
      render(template, {}, { options }, { now });
    expect(at("%currentyear%")).toBe("2026");
    expect(at("%currentmonth%")).toBe("October");
    expect(at("%currentday%")).toBe("2");
    expect(at("%currentdate%")).toBe("October 2, 2026");
    expect(at("%currenttime%")).toBe("2:05 pm");
    expect(at("%currenttime(H:i:s)%")).toBe("14:05:09");
    expect(at("%currentdate%", { date_format: "Y/m/d" })).toBe("2026/10/02");
    expect(at("%currenttime%", { time_format: "H\\h" })).toBe("14h");
    expect(at("%currentyear%", { timezone_string: "Pacific/Auckland" })).toBe("2026");
    expect(at("%currentday%", { timezone_string: "Pacific/Auckland" })).toBe("3");
    // Without a clock it is now.
    expect(render("%currentyear%")).toBe(String(new Date().getUTCFullYear()));
  });

  test("terms: the first by name, or all of them, with the limits Rank Math's arguments give", () => {
    expect(render("%category%")).toBe("Apple");
    expect(render("%categories%")).toBe("Apple, Mango, Zebra");
    expect(render("%categories(limit=2)%")).toBe("Apple, Mango");
    expect(render("%categories(limit=2&separator= | )%")).toBe("Apple | Mango");
    expect(render("%categories(exclude=2,3)%")).toBe("Zebra");
    expect(render("%categories(limit=2&exclude=2)%")).toBe("Mango");
    // The limit comes first: the one that is left of the first is excluded, and nothing is left.
    expect(render("[%categories(limit=1&exclude=2)%]")).toBe("[]");
    expect(render("%tag%")).toBe("Alpha");
    expect(render("%tags%")).toBe("Alpha, Beta");
    expect(render("%tags(separator=/)%")).toBe("Alpha/Beta");
    expect(render("%customterm(genre)%")).toBe("Jazz");
    expect(render("%customterm_desc(genre)%")).toBe("Cool");
    expect(render("[%customterm(nothing)%]")).toBe("[]");
    expect(render("[%customterm_desc(nothing)%]")).toBe("[]");
    expect(render("[%customterm()%]")).toBe("[]");
    expect(render("[%customterm_desc()%]")).toBe("[]");
    expect(render("[%category%]", {}, { rel: {} })).toBe("[]");
    expect(render("[%tags%]", {}, { rel: {} })).toBe("[]");
    // The type's primary taxonomy.
    expect(
      render("%primary_taxonomy_terms%", {}, { titles: { pt_post_primary_taxonomy: "genre" } }),
    ).toBe("Jazz");
    expect(
      render("%primary_taxonomy_terms%", {}, { titles: { pt_post_primary_taxonomy: "category" } }),
    ).toBe("Apple, Mango, Zebra");
    expect(render("[%primary_taxonomy_terms%]")).toBe("[]");
    expect(
      render("[%primary_taxonomy_terms%]", {}, { titles: { pt_post_primary_taxonomy: "nothing" } }),
    ).toBe("[]");
  });

  test("custom fields, thumbnails, the url", () => {
    expect(render("%customfield(subtitle)%", {}, { postMeta: { subtitle: ["Sub"] } })).toBe("Sub");
    expect(render("%customfield(count)%", {}, { postMeta: { count: [42] } })).toBe("42");
    expect(render("[%customfield(list)%]", {}, { postMeta: { list: [["a"]] } })).toBe("[]");
    expect(render("[%customfield(none)%]")).toBe("[]");
    expect(render("[%customfield()%]")).toBe("[]");
    const att = wpAttachment({
      id: 30,
      file: "t.jpg",
      url: "https://x.test/wp-content/uploads/t.jpg",
    });
    expect(
      render("%post_thumbnail%", {}, { postMeta: { _thumbnail_id: ["30"] }, attachments: [att] }),
    ).toBe("https://x.test/wp-content/uploads/t.jpg");
    expect(
      render("[%post_thumbnail%]", {}, { postMeta: { _thumbnail_id: ["31"] }, attachments: [att] }),
    ).toBe("[]");
    expect(render("[%post_thumbnail%]")).toBe("[]");
    expect(
      render(
        "%url%",
        {},
        {},
        { permalink: (t) => (t.kind === "post" ? `https://x.test/p${t.post.id}/` : undefined) },
      ),
    ).toBe("https://x.test/p900/");
    expect(render("[%url%]")).toBe("[]");
    expect(render("%seo_title%", { title: "Mine" })).toBe("Mine");
    expect(render("%seo_description%", { title: "Mine", excerpt: "Excerpt" })).toBe("Excerpt");
  });

  test("the site: name, tagline, and what the site name's own markup does to them", () => {
    expect(render("%sitename% / %sitedesc%")).toBe("X Site / A tagline");
    expect(
      render(
        "%sitename% / %sitedesc%",
        {},
        { site: { name: "<b>Bold</b>\n Name", description: "<i>Tag</i> line" } },
      ),
    ).toBe("Bold Name / Tag line");
    expect(render("%sitename%", {}, { site: { name: "Fish &amp; Chips" } })).toBe("Fish & Chips");
  });
});

describe("the variables of a term and of an archive", () => {
  const term = wpTerm({
    termId: 60,
    taxonomy: "genre",
    slug: "jazz",
    name: "Jazz",
    description: "<b>Cool</b> music &amp; more",
    meta: { rank_math_focus_keyword: "swing, bebop", mood: "blue", rating: 5, list: ["x"] },
  });
  const render = (template: string, t: WpTerm = term, now?: Date): string => {
    const model = modelOf([], { terms: [t], titles: { tax_genre_title: template } });
    return seoFor(model, { kind: "term", term: t }, now ? { now } : {}).title;
  };

  test("a term answers for itself, and what a post would answer is empty", () => {
    expect(render("%term%")).toBe("Jazz");
    expect(render("%term_description%")).toBe("Cool music & more");
    expect(render("[%term_description%]", { ...term, description: "" })).toBe("[]");
    expect(render("%focuskw% / %keywords%")).toBe("swing / swing, bebop");
    expect(
      render(
        "%customfield(mood)% %customfield(rating)% [%customfield(list)%] [%customfield(none)%]",
      ),
    ).toBe("blue 5 [] []");
    expect(render("[%customfield()%]")).toBe("[]");
    expect(
      render(
        "[%id%] [%userid%] [%name%] [%excerpt%] [%date%] [%category%] [%tag%] [%parent_title%]",
      ),
    ).toBe("[] [] [] [] [] [] [] []");
    expect(
      render("[%customterm(genre)%] [%customterm_desc(genre)%] [%primary_taxonomy_terms%]"),
    ).toBe("[] [] []");
    expect(
      render("[%pt_single%] [%pt_plural%] [%post_thumbnail%] [%excerpt_only%] [%modified%]"),
    ).toBe("[] [] [] [] []");
    expect(render("%pagetotal% %currentyear%", term, new Date("2025-01-01T00:00:00Z"))).toBe(
      "1 2025",
    );
  });

  test("an archive is named for its post type", () => {
    const def = wpPost({
      id: 70,
      type: "acf-post-type",
      slug: "post_type_x",
      title: "Projects",
      content: serialize({
        post_type: "project",
        labels: { name: "Projects", singular_name: "Project" },
      }),
    });
    const model = modelOf([def], {
      titles: {
        pt_project_archive_title:
          "%title% / %pt_single% / %pt_plural% / [%id%] [%name%] [%excerpt%] [%term%]",
      },
    });
    expect(seoFor(model, { kind: "archive", postType: "project" }).title).toBe(
      "Projects / Project / Projects / [] [] [] []",
    );
  });
});

// ── The template engine ──────────────────────────────────────────────────────────────────────────

describe("renderRankMathTemplate: names, arguments and the report", () => {
  test("every variable Rank Math 1.0.253 registers is known, and any other name is reported", () => {
    const registered = [
      "sep",
      "search_query",
      "count",
      "filename",
      "sitename",
      "sitedesc",
      "currentdate",
      "currentday",
      "currentmonth",
      "currentyear",
      "currenttime",
      "org_name",
      "org_logo",
      "org_url",
      "title",
      "parent_title",
      "excerpt",
      "excerpt_only",
      "seo_title",
      "seo_description",
      "url",
      "post_thumbnail",
      "date",
      "modified",
      "category",
      "categories",
      "primary_taxonomy_terms",
      "tag",
      "tags",
      "term",
      "term_description",
      "customterm",
      "customterm_desc",
      "userid",
      "name",
      "post_author",
      "user_description",
      "id",
      "focuskw",
      "keywords",
      "customfield",
      "page",
      "pagenumber",
      "pagetotal",
      "pt_single",
      "pt_plural",
    ];
    const report = createReport();
    for (const name of registered)
      expect(renderRankMathTemplate(`[%${name}%]`, {}, { report, where: "post:1" })).toBe("[]");
    // The two that take arguments through an `_args` twin.
    expect(renderRankMathTemplate("%categories(a=1)%", {}, { report, where: "post:1" })).toBe("");
    expect(codes(report, "seo.unknown-variable")).toEqual([]);
    for (const name of ["brand", "Title2", "title_", "a-b"]) {
      const lone = createReport();
      expect(renderRankMathTemplate(`[%${name}%]`, {}, { report: lone })).toBe("[]");
      expect(codes(lone, "seo.unknown-variable")).toHaveLength(1);
    }
  });

  test("a variable with arguments takes its value from the plain name or its `_args` twin", () => {
    const vars: RankMathVars = {
      plain: (a) => `plain(${a})`,
      twin_args: (a) => `twin(${a})`,
    };
    expect(renderRankMathTemplate("%plain% %plain(x)% %plain()%", vars)).toBe("plain() plain(x) ");
    // (An empty argument list is not an argument: `%plain()%` names a variable that has `()` in its name, which is none.)
    // `%twin%` alone is not a variable: only `%twin(…)%` finds `twin_args`.
    const report = createReport();
    expect(renderRankMathTemplate("[%twin%] [%twin(y)%]", vars, { report })).toBe("[] [twin(y)]");
    expect(codes(report, "seo.unknown-variable").map((e) => e.data)).toEqual([
      { variable: "twin", template: "[%twin%] [%twin(y)%]" },
    ]);
    // A plain name wins over its twin.
    expect(
      renderRankMathTemplate("%both(1)%", { both: () => "plain", both_args: () => "twin" }),
    ).toBe("plain");
  });

  test("the clock variables are reported once for each place, and the unknown ones are not clock variables", () => {
    const report = createReport();
    const vars: RankMathVars = { currentyear: "2026", currentdate: "x" };
    renderRankMathTemplate("%currentyear% %currentyear% %currentdate%", vars, {
      report,
      where: "post:1",
      url: "https://x.test/a/",
    });
    renderRankMathTemplate("%currentyear%", vars, { report, where: "post:2" });
    renderRankMathTemplate("%currentyear%", vars, { report });
    const found = codes(report, "seo.dynamic-variable");
    expect(found.map((e) => [e.where, e.data])).toEqual([
      ["post:1", { variable: "currentyear" }],
      ["post:1", { variable: "currentdate" }],
      ["post:2", { variable: "currentyear" }],
    ]);
    expect(found[0]).toMatchObject({ severity: "info", url: "https://x.test/a/" });
    expect(found[2]!.url).toBeUndefined();
    const other = createReport();
    renderRankMathTemplate("%title%", { title: "T" }, { report: other, where: "post:1" });
    expect(codes(other, "seo.dynamic-variable")).toEqual([]);
  });

  test("an unknown variable prints nothing and does not count as a clock", () => {
    const report = createReport();
    expect(renderRankMathTemplate("a %nothing% b", {}, { report, where: "post:3" })).toBe("a b");
    expect(codes(report, "seo.unknown-variable")[0]).toMatchObject({
      severity: "warn",
      where: "post:3",
    });
    expect(codes(report, "seo.unknown-variable")[0]!.url).toBeUndefined();
    expect(codes(report, "seo.dynamic-variable")).toEqual([]);
  });
});
// </batch1>

// <batch2>

// ── Robots ───────────────────────────────────────────────────────────────────────────────────────

describe("robots", () => {
  const ADVANCED = "max-snippet:-1, max-video-preview:-1, max-image-preview:large";
  const robots = (
    meta: Record<string, unknown> = {},
    titles: Record<string, unknown> = {},
    post: Partial<WpPost> = {},
    options: Record<string, string> = {},
  ): string =>
    seoOfPost(post, {
      titles,
      options,
      postMeta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [`rank_math_${k}`, [v]])),
    }).robots;

  test("what a post says, in the order Rank Math prints it", () => {
    expect(robots()).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({ robots: ["noindex", "nofollow"] })).toBe("nofollow, noindex");
    expect(robots({ robots: ["noindex"] })).toBe("follow, noindex");
    expect(robots({ robots: ["nofollow"] })).toBe(`index, nofollow, ${ADVANCED}`);
    expect(robots({ robots: ["index", "nosnippet"] })).toBe("follow, index, nosnippet");
    expect(robots({ robots: ["noarchive"] })).toBe(`follow, index, noarchive, ${ADVANCED}`);
    expect(robots({ robots: ["noimageindex", "noarchive"] })).toBe(
      `follow, index, noimageindex, noarchive, ${ADVANCED}`,
    );
    // A directive Rank Math does not print is dropped, and index and follow are always there.
    expect(robots({ robots: ["noodp", "noydir"] })).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({ robots: ["noodp", "noindex"] })).toBe("follow, noindex");
    // Twice is once.
    expect(robots({ robots: ["noarchive", "noarchive", "index"] })).toBe(
      `follow, noarchive, index, ${ADVANCED}`,
    );
    // Not a list: nothing, so the site's own.
    expect(robots({ robots: "noindex" })).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({ robots: [] })).toBe(`follow, index, ${ADVANCED}`);
    // A directive of a kind that is not Rank Math's is no directive; what is left is the page's own, so the site's does not apply.
    expect(robots({ robots: [7] }, { robots_global: ["noindex"] })).toBe(
      `follow, index, ${ADVANCED}`,
    );
  });

  test("the site's own robots, when the post has none", () => {
    expect(robots({}, { robots_global: ["noindex"] })).toBe("follow, noindex");
    expect(robots({}, { robots_global: ["noindex", "nofollow"] })).toBe("nofollow, noindex");
    expect(robots({}, { robots_global: ["index", "noarchive"] })).toBe(
      `follow, index, noarchive, ${ADVANCED}`,
    );
    // Nothing there to combine (or not a list at all): Rank Math's own pair, index first.
    expect(robots({}, { robots_global: [] })).toBe(`index, follow, ${ADVANCED}`);
    expect(robots({}, { robots_global: "noindex" })).toBe(`index, follow, ${ADVANCED}`);
    // The post's wins.
    expect(robots({ robots: ["index"] }, { robots_global: ["noindex"] })).toBe(
      `follow, index, ${ADVANCED}`,
    );
  });

  test("the type's custom robots are used when the type asks, and only then", () => {
    expect(robots({}, { pt_post_robots: ["noindex"] })).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({}, { pt_post_custom_robots: "on", pt_post_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(robots({}, { pt_post_custom_robots: "off", pt_post_robots: ["noindex"] })).toBe(
      `follow, index, ${ADVANCED}`,
    );
    // Switched on with nothing chosen: Rank Math's own default, in its own order.
    expect(robots({}, { pt_post_custom_robots: "on" })).toBe(`index, follow, ${ADVANCED}`);
    expect(robots({}, { pt_post_custom_robots: "on", pt_post_robots: [] })).toBe(
      `index, follow, ${ADVANCED}`,
    );
    // The post's own comes first.
    expect(
      robots(
        { robots: ["noarchive"] },
        { pt_post_custom_robots: "on", pt_post_robots: ["noindex"] },
      ),
    ).toBe(`follow, index, noarchive, ${ADVANCED}`);
    // The type's advanced robots stand in for the site's.
    expect(
      robots(
        {},
        {
          pt_post_custom_robots: "on",
          pt_post_robots: ["index", "noarchive"],
          pt_post_advanced_robots: { "max-snippet": "50" },
        },
      ),
    ).toBe("follow, index, noarchive, max-snippet:50");
    expect(
      robots(
        {},
        { pt_post_custom_robots: "off", pt_post_advanced_robots: { "max-snippet": "50" } },
      ),
    ).toBe(`follow, index, ${ADVANCED}`);
  });

  test("advanced robots: the post's, else the type's, else the site's with Rank Math's defaults under them", () => {
    expect(
      robots({
        advanced_robots: {
          "max-snippet": "20",
          "max-video-preview": "-1",
          "max-image-preview": "none",
          unavailable_after: "01 Jan 2030",
        },
      }),
    ).toBe("follow, index, max-snippet:20, max-video-preview:-1, max-image-preview:none");
    // Only what is set is printed: a directive left empty is not there at all.
    expect(robots({ advanced_robots: { "max-snippet": "", "max-image-preview": "large" } })).toBe(
      "follow, index, max-image-preview:large",
    );
    expect(robots({ advanced_robots: { "max-snippet": "", "max-video-preview": "0" } })).toBe(
      "follow, index",
    );
    // None at all is not a choice.
    expect(robots({ advanced_robots: {} })).toBe(`follow, index, ${ADVANCED}`);
    // The site's setting overrides Rank Math's defaults one by one.
    expect(robots({}, { advanced_robots_global: { "max-snippet": "30" } })).toBe(
      "follow, index, max-snippet:30, max-video-preview:-1, max-image-preview:large",
    );
    expect(robots({}, { advanced_robots_global: { "max-image-preview": "standard" } })).toBe(
      "follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:standard",
    );
    expect(
      robots({}, { advanced_robots_global: { "max-snippet": "", "max-video-preview": "" } }),
    ).toBe("follow, index, max-image-preview:large");
    // With nothing in the settings, the defaults.
    expect(robots({}, { advanced_robots_global: [] })).toBe(`follow, index, ${ADVANCED}`);
    // Something that is not a list of directives is no directive at all.
    expect(robots({ advanced_robots: "x" })).toBe("follow, index");
    expect(robots({ advanced_robots: "0" })).toBe(`follow, index, ${ADVANCED}`);
  });

  test("a page that is noindex or nosnippet has no advanced robots", () => {
    expect(robots({ robots: ["noindex"], advanced_robots: { "max-snippet": "5" } })).toBe(
      "follow, noindex",
    );
    expect(robots({ robots: ["nosnippet"], advanced_robots: { "max-snippet": "5" } })).toBe(
      "follow, index, nosnippet",
    );
  });

  test("a private post is noindex, a protected one when the site says so, a site that hides from search engines everywhere", () => {
    expect(robots({}, {}, { status: "private" })).toBe("follow, noindex");
    expect(robots({ robots: ["noarchive"] }, {}, { status: "private" })).toBe(
      "follow, noarchive, noindex",
    );
    expect(robots({}, {}, { passwordProtected: true })).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({}, { noindex_password_protected: "on" }, { passwordProtected: true })).toBe(
      "follow, noindex",
    );
    expect(robots({}, { noindex_password_protected: "on" })).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({}, { noindex_password_protected: "off" }, { passwordProtected: true })).toBe(
      `follow, index, ${ADVANCED}`,
    );
    expect(robots({}, {}, {}, { blog_public: "0" })).toBe("nofollow, noindex");
    expect(robots({ robots: ["noarchive"] }, {}, {}, { blog_public: "0" })).toBe(
      "nofollow, noindex, noarchive",
    );
    expect(robots({}, {}, {}, { blog_public: "1" })).toBe(`follow, index, ${ADVANCED}`);
    expect(robots({}, {}, {}, { blog_public: "" })).toBe("nofollow, noindex");
  });

  test("a term: its own, its taxonomy's, and noindex while it is empty", () => {
    const term = wpTerm({ termId: 60, taxonomy: "genre", count: 4 });
    const of = (t: WpTerm, titles: Record<string, unknown> = {}, more: WpTerm[] = []): string => {
      const model = modelOf([], { terms: [t, ...more], titles });
      return seoFor(model, { kind: "term", term: t }).robots;
    };
    expect(of(term)).toBe(`follow, index, ${ADVANCED}`);
    expect(of({ ...term, meta: { rank_math_robots: ["noindex"] } })).toBe("follow, noindex");
    expect(of(term, { tax_genre_custom_robots: "on", tax_genre_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(of(term, { tax_genre_custom_robots: "on" })).toBe(`index, follow, ${ADVANCED}`);
    expect(of(term, { tax_genre_robots: ["noindex"] })).toBe(`follow, index, ${ADVANCED}`);
    expect(
      of(
        { ...term, meta: { rank_math_robots: ["noarchive"] } },
        { tax_genre_custom_robots: "on", tax_genre_robots: ["noindex"] },
      ),
    ).toBe(`follow, index, noarchive, ${ADVANCED}`);
    expect(
      of(term, {
        tax_genre_custom_robots: "on",
        tax_genre_robots: ["index"],
        tax_genre_advanced_robots: { "max-snippet": "9" },
      }),
    ).toBe("follow, index, max-snippet:9");
    expect(
      of(
        { ...term, meta: { rank_math_advanced_robots: { "max-snippet": "7" } } },
        { tax_genre_custom_robots: "on", tax_genre_advanced_robots: { "max-snippet": "9" } },
      ),
    ).toBe("index, follow, max-snippet:7");
    // An emptied advanced list of the term's own gives way to the taxonomy's.
    expect(
      of(
        { ...term, meta: { rank_math_advanced_robots: { "max-snippet": "" } } },
        { tax_genre_custom_robots: "on", tax_genre_advanced_robots: { "max-snippet": "9" } },
      ),
    ).toBe("index, follow, max-snippet:9");
    // An empty term is noindex when the site says so, unless it has children.
    const empty = { ...term, count: 0 };
    expect(of(empty)).toBe(`follow, index, ${ADVANCED}`);
    expect(of(empty, { noindex_empty_taxonomies: "on" })).toBe("follow, noindex");
    expect(of(empty, { noindex_empty_taxonomies: "off" })).toBe(`follow, index, ${ADVANCED}`);
    expect(of(term, { noindex_empty_taxonomies: "on" })).toBe(`follow, index, ${ADVANCED}`);
    const child = wpTerm({ termId: 61, taxonomy: "genre", parent: 60 });
    expect(of(empty, { noindex_empty_taxonomies: "on" }, [child])).toBe(
      `follow, index, ${ADVANCED}`,
    );
    const stranger = wpTerm({ termId: 62, taxonomy: "other", parent: 60 });
    expect(of(empty, { noindex_empty_taxonomies: "on" }, [stranger])).toBe("follow, noindex");
    const sibling = wpTerm({ termId: 63, taxonomy: "genre", parent: 99 });
    expect(of(empty, { noindex_empty_taxonomies: "on" }, [sibling])).toBe("follow, noindex");
  });

  test("an archive and the home page: the custom robots of the type or of the page", () => {
    const archive = (titles: Record<string, unknown>): string =>
      seoFor(modelOf([], { titles }), { kind: "archive", postType: "book" }).robots;
    // An archive says nothing about advanced robots unless its type has custom robots: the answer is an empty list, not none.
    expect(archive({})).toBe("follow, index");
    expect(archive({ pt_book_robots: ["noindex"] })).toBe("follow, index");
    expect(archive({ pt_book_custom_robots: "on" })).toBe(`follow, index, ${ADVANCED}`);
    expect(archive({ pt_book_custom_robots: "on", pt_book_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(
      archive({
        pt_book_custom_robots: "on",
        pt_book_robots: ["index"],
        pt_book_advanced_robots: { "max-snippet": "3" },
      }),
    ).toBe("follow, index, max-snippet:3");
    const home = (titles: Record<string, unknown>): string =>
      seoFor(modelOf([], { titles }), { kind: "home" }).robots;
    expect(home({})).toBe("follow, index");
    expect(home({ homepage_robots: ["noindex"] })).toBe("follow, index");
    expect(home({ homepage_custom_robots: "on" })).toBe(`follow, index, ${ADVANCED}`);
    expect(home({ homepage_custom_robots: "on", homepage_robots: ["noindex"] })).toBe(
      "follow, noindex",
    );
    expect(
      home({
        homepage_custom_robots: "on",
        homepage_robots: ["index"],
        homepage_advanced_robots: { "max-snippet": "4" },
      }),
    ).toBe("follow, index, max-snippet:4");
    expect(home({ homepage_advanced_robots: { "max-snippet": "4" } })).toBe("follow, index");
  });
});

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

describe("the image of a page, more closely", () => {
  const att = (o: Partial<WpAttachment> & { id: number }): WpAttachment =>
    wpAttachment({ file: "pic.jpg", url: "https://x.test/wp-content/uploads/pic.jpg", ...o });
  const featured = (
    attachment: WpAttachment,
    parts: Parts = {},
    post: Partial<WpPost> = {},
  ): Seo["image"] =>
    seoOfPost(post, {
      ...parts,
      attachments: [attachment],
      postMeta: { _thumbnail_id: [String(attachment.id)] },
    }).image;

  test("sizes are judged at 200 and 2000 pixels, inclusive, in both directions", () => {
    expect(featured(att({ id: 1, width: 200, height: 200 }))).toMatchObject({ width: 200 });
    expect(featured(att({ id: 1, width: 2000, height: 200 }))).toMatchObject({ width: 2000 });
    expect(featured(att({ id: 1, width: 200, height: 2000 }))).toMatchObject({ height: 2000 });
    expect(featured(att({ id: 1, width: 199, height: 200 }))).toBeUndefined();
    expect(featured(att({ id: 1, width: 200, height: 199 }))).toBeUndefined();
    expect(featured(att({ id: 1, width: 2001, height: 2001 }))).toMatchObject({ width: 1024 });
    expect(featured(att({ id: 1, width: 1000, height: 2001 }))).toMatchObject({
      width: 512,
      height: 1024,
    });
  });

  test("the sizes the site sets, and a setting that makes no sense", () => {
    const wide = att({ id: 1, width: 3000, height: 1500 });
    expect(
      featured(wide, { options: { large_size_w: "1500", large_size_h: "1500" } }),
    ).toMatchObject({
      width: 1500,
      height: 750,
    });
    expect(featured(wide, { options: { large_size_w: "0", large_size_h: "0" } })).toMatchObject({
      width: 1024,
      height: 512,
    });
    expect(featured(wide, { options: { large_size_w: "x", large_size_h: "-5" } })).toMatchObject({
      width: 1024,
      height: 512,
    });
    expect(
      featured(wide, { options: { large_size_w: "1800", large_size_h: "300" } }),
    ).toMatchObject({
      width: 600,
      height: 300,
    });
  });

  test("medium_large when large is too small, scaled to the site's size when there is none", () => {
    const sizes = [
      { name: "large", file: "pic-150x100.jpg", width: 150, height: 100 },
      { name: "medium_large", file: "pic-768x512.jpg", width: 768, height: 512 },
    ];
    // Full is too big, large is too small: the medium_large copy.
    expect(featured(att({ id: 1, width: 4000, height: 2667, sizes }))).toMatchObject({
      url: "https://x.test/wp-content/uploads/pic-768x512.jpg",
      width: 768,
      height: 512,
    });
    // With no copy of that size either, the full file at the size's width (its height is free).
    const only = [{ name: "large", file: "pic-150x100.jpg", width: 150, height: 100 }];
    expect(featured(att({ id: 1, width: 4000, height: 2000, sizes: only }))).toMatchObject({
      url: "https://x.test/wp-content/uploads/pic.jpg",
      width: 768,
      height: 384,
    });
    expect(
      featured(att({ id: 1, width: 4000, height: 2000, sizes: only }), {
        options: { medium_large_size_w: "1000" },
      }),
    ).toMatchObject({ width: 1000, height: 500 });
    // Tall: the height has no limit of its own on medium_large (0 means none), the width does.
    expect(featured(att({ id: 1, width: 1000, height: 6000, sizes: only }))).toBeUndefined();
  });

  test("where the file is, and what the address looks like", () => {
    const sizes = [{ name: "large", file: "pic-1024x683.jpg", width: 1024, height: 683 }];
    // An attachment's own address, with its query string removed.
    expect(
      featured(
        att({
          id: 1,
          width: 800,
          height: 600,
          url: "https://x.test/wp-content/uploads/pic.jpg?v=2",
        }),
      ),
    ).toMatchObject({ url: "https://x.test/wp-content/uploads/pic.jpg" });
    // A guid on a media host stays on it, and so do the sizes.
    expect(
      featured(
        att({
          id: 1,
          width: 3000,
          height: 2000,
          sizes,
          file: "2024/pic.jpg",
          url: "https://media.x.test/2024/pic.jpg",
        }),
      ),
    ).toMatchObject({ url: "https://media.x.test/2024/pic-1024x683.jpg" });
    // A guid that does not name the file: the uploads folder of the site.
    expect(
      featured(
        att({
          id: 1,
          width: 800,
          height: 600,
          file: "2024/pic.jpg",
          url: "https://x.test/?attachment_id=1",
        }),
      ),
    ).toMatchObject({ url: "https://x.test/wp-content/uploads/2024/pic.jpg" });
    // A file that is itself an address.
    expect(
      featured(
        att({
          id: 1,
          width: 800,
          height: 600,
          file: "https://cdn.test/a/pic.png",
          mime: "image/png",
        }),
      ),
    ).toMatchObject({ url: "https://cdn.test/a/pic.png" });
    expect(
      featured(
        att({ id: 1, width: 800, height: 600, file: "//cdn.test/a/pic.png", mime: "image/png" }),
      ),
    ).toMatchObject({ url: "//cdn.test/a/pic.png" });
    // The extension is judged on the address that is printed, and is case-insensitive.
    expect(
      featured(
        att({
          id: 1,
          width: 800,
          height: 600,
          file: "PIC.JPG",
          url: "https://x.test/wp-content/uploads/PIC.JPG",
        }),
      ),
    ).toMatchObject({ id: 1 });
    expect(
      featured(
        att({
          id: 1,
          width: 800,
          height: 600,
          file: "pic.tiff",
          url: "https://x.test/wp-content/uploads/pic.tiff",
          mime: "image/tiff",
        }),
      ),
    ).toBeUndefined();
    expect(
      featured(
        att({
          id: 1,
          width: 800,
          height: 600,
          file: "pic",
          url: "https://x.test/wp-content/uploads/pic",
        }),
      ),
    ).toBeUndefined();
  });

  test("the alt text, and a description when there is none", () => {
    expect(
      featured(att({ id: 1, width: 800, height: 600, alt: "A pic" }), {}, { title: "Title" })?.alt,
    ).toBe("A pic");
    expect(
      featured(att({ id: 1, width: 800, height: 600 }), {}, { title: "The &amp; Title" })?.alt,
    ).toBe("The & Title");
    expect(
      seoOfPost(
        { title: "Title" },
        {
          attachments: [att({ id: 1, width: 800, height: 600 })],
          postMeta: { _thumbnail_id: ["1"], rank_math_focus_keyword: ["first, second"] },
        },
      ).image?.alt,
    ).toBe("first");
    expect(
      featured(att({ id: 1, width: 800, height: 600 }), {}, { title: "" })?.alt,
    ).toBeUndefined();
  });

  test("ids that are not ids", () => {
    const report = createReport();
    const a = att({ id: 1, width: 800, height: 600 });
    for (const bad of ["abc", "0", "-3", "", [1], null]) {
      const seo = seoOfPost(
        {},
        {
          attachments: [a],
          postMeta: { rank_math_facebook_image_id: [bad], _thumbnail_id: ["1"] },
        },
        { report },
      );
      expect(seo.image?.id).toBe(1);
    }
    expect(codes(report, "seo.image-unresolved")).toEqual([]);
    // A number is as good as a string, and an id in the model that is no image is not reported.
    expect(
      seoOfPost(
        {},
        { attachments: [a], postMeta: { rank_math_facebook_image_id: [1] } },
        { report },
      ).image?.id,
    ).toBe(1);
  });

  test("the default social image, last", () => {
    const a = att({
      id: 1,
      file: "a.jpg",
      url: "https://x.test/wp-content/uploads/a.jpg",
      width: 800,
      height: 600,
    });
    const b = att({
      id: 2,
      file: "b.jpg",
      url: "https://x.test/wp-content/uploads/b.jpg",
      width: 800,
      height: 600,
    });
    expect(
      seoOfPost({}, { attachments: [a, b], titles: { open_graph_image_id: "2" } }).image?.id,
    ).toBe(2);
    expect(
      seoOfPost(
        {},
        {
          attachments: [a, b],
          titles: { open_graph_image_id: "2" },
          postMeta: { _thumbnail_id: ["1"] },
        },
      ).image?.id,
    ).toBe(1);
    const report = createReport();
    expect(
      seoOfPost({}, { attachments: [a], titles: { open_graph_image_id: "9" } }, { report }).image,
    ).toBeUndefined();
    expect(codes(report, "seo.image-unresolved")[0]!.message).toContain("default social image");
    // A term, an archive and the front page of a blog use it too.
    const term = wpTerm({ termId: 60, taxonomy: "genre" });
    const model = modelOf([], {
      attachments: [a, b],
      terms: [term],
      titles: { open_graph_image_id: "2" },
    });
    expect(seoFor(model, { kind: "term", term }).image?.id).toBe(2);
    expect(seoFor(model, { kind: "term", term }).twitter.image?.id).toBe(2);
    expect(seoFor(model, { kind: "archive", postType: "book" }).image?.id).toBe(2);
    expect(seoFor(model, { kind: "home" }).image?.id).toBe(2);
    expect(seoFor(model, { kind: "home" }).twitter.image?.id).toBe(2);
    // The type's own, on an archive.
    const own = modelOf([], {
      attachments: [a, b],
      titles: { open_graph_image_id: "2", pt_book_facebook_image_id: "1" },
    });
    expect(seoFor(own, { kind: "archive", postType: "book" }).image?.id).toBe(1);
    expect(seoFor(own, { kind: "archive", postType: "film" }).image?.id).toBe(2);
    // The term's own.
    const termOwn = {
      ...term,
      meta: { rank_math_facebook_image_id: "1", rank_math_twitter_image_id: "2" },
    };
    const m2 = modelOf([], { attachments: [a, b], terms: [termOwn] });
    const seo = seoFor(m2, { kind: "term", term: termOwn });
    expect([seo.image?.id, seo.twitter.image?.id]).toEqual([1, 2]);
    const shared = {
      ...term,
      meta: {
        rank_math_facebook_image_id: "1",
        rank_math_twitter_image_id: "2",
        rank_math_twitter_use_facebook: "on",
      },
    };
    expect(
      seoFor(modelOf([], { attachments: [a, b], terms: [shared] }), { kind: "term", term: shared })
        .twitter.image?.id,
    ).toBe(1);
  });

  test("the home page's own image comes after the featured one, and only on the home page", () => {
    const a = att({
      id: 1,
      file: "a.jpg",
      url: "https://x.test/wp-content/uploads/a.jpg",
      width: 800,
      height: 600,
    });
    const b = att({
      id: 2,
      file: "b.jpg",
      url: "https://x.test/wp-content/uploads/b.jpg",
      width: 800,
      height: 600,
    });
    const front = wpPost({ id: 10, type: "page", slug: "welcome", title: "Welcome" });
    const model = modelOf([front], {
      site: { showOnFront: "page", pageOnFront: 10 },
      attachments: [a, b],
      titles: { homepage_facebook_image_id: "1", open_graph_image_id: "2" },
    });
    expect(seoFor(model, { kind: "home" }).image?.id).toBe(1);
    expect(seoFor(model, { kind: "post", post: front }).image?.id).toBe(2);
    const withFeatured = modelOf([front], {
      site: { showOnFront: "page", pageOnFront: 10 },
      attachments: [a, b],
      meta: { 10: { _thumbnail_id: ["2"] } },
      titles: { homepage_facebook_image_id: "1" },
    });
    expect(seoFor(withFeatured, { kind: "home" }).image?.id).toBe(2);
  });
});

describe("the image found in a post's content", () => {
  const upload = (file: string, o: Partial<WpAttachment> = {}): WpAttachment =>
    wpAttachment({
      id: Number(/(\d+)\.\w+$/.exec(file)![1]),
      file,
      url: `https://x.test/wp-content/uploads/${file}`,
      width: 800,
      height: 600,
      ...o,
    });
  const imageOf = (
    content: string,
    attachments: WpAttachment[] = [],
    meta: Record<string, unknown[]> = {},
    parts: Parts = {},
  ): Seo["image"] => seoOfPost({ content }, { ...parts, attachments, postMeta: meta }).image;

  test("an image from the library, by address, by path and by the original of a resized copy", () => {
    const a = upload("2024/05/a1.jpg");
    expect(imageOf('<img src="https://x.test/wp-content/uploads/2024/05/a1.jpg">', [a])?.id).toBe(
      1,
    );
    expect(imageOf('<img src="/wp-content/uploads/2024/05/a1.jpg">', [a])?.id).toBe(1);
    expect(
      imageOf('<img src="https://x.test/wp-content/uploads/2024/05/a1-300x200.jpg">', [a])?.id,
    ).toBe(1);
    expect(
      imageOf('<img src="https://x.test/wp-content/uploads/2024/05/a1-300x200.png">', [
        upload("2024/05/a1.png", { mime: "image/png", id: 1 }),
      ])?.id,
    ).toBe(1);
    expect(
      imageOf('<img src="https://x.test/wp-content/uploads/2024/05/a1-300x200.webp">', [a])?.url,
    ).toBe("https://x.test/wp-content/uploads/2024/05/a1-300x200.webp");
    expect(imageOf("<img src='/wp-content/uploads/2024/05/a1.jpg?x=1'>", [a])?.id).toBe(1);
    expect(
      imageOf('<img class="x" alt="y" src="/wp-content/uploads/2024/05/a1.jpg" width="3">', [a])
        ?.id,
    ).toBe(1);
    // The guid itself.
    const odd = upload("elsewhere/z2.jpg", { url: "https://x.test/files/z2.jpg" });
    expect(imageOf('<img src="https://x.test/files/z2.jpg">', [odd])?.id).toBe(2);
    // An uploads folder with a prefix of its own.
    expect(
      imageOf('<img src="https://x.test/blog/wp-content/uploads/2024/05/a1.jpg">', [a])?.id,
    ).toBe(1);
    // A file the library keeps with the folder in its name.
    const kept = upload("wp-content/uploads/2024/k3.jpg", {
      url: "https://x.test/wp-content/uploads/2024/k3.jpg",
    });
    expect(imageOf('<img src="https://x.test/wp-content/uploads/2024/k3.jpg">', [kept])?.id).toBe(
      3,
    );
    // The path is decoded.
    expect(
      imageOf('<img src="/wp-content/uploads/2024/05/my%20pic4.jpg">', [
        upload("2024/05/my pic4.jpg"),
      ])?.id,
    ).toBe(4);
  });

  test("an image that is not in the library: its own address, when it is an image", () => {
    expect(imageOf('<img src="https://other.test/p/x.png?w=1">')?.url).toBe(
      "https://other.test/p/x.png",
    );
    expect(imageOf('<img src="https://other.test/p/x.PNG">')?.url).toBe(
      "https://other.test/p/x.PNG",
    );
    expect(imageOf('<img src="/wp-content/uploads/unknown.jpg">')?.url).toBe(
      "https://x.test/wp-content/uploads/unknown.jpg",
    );
    expect(imageOf('<img src="/images/pic.gif">')?.url).toBe("https://x.test/images/pic.gif");
    expect(imageOf('<img src="https://other.test/p/x.svg">')).toBeUndefined();
    expect(imageOf('<img src="https://other.test/p/x">')).toBeUndefined();
    expect(imageOf('<img src="https://other.test/p/x.jpg.txt">')).toBeUndefined();
    expect(imageOf('<img src="">')).toBeUndefined();
    expect(imageOf("<img alt='no source'>")).toBeUndefined();
    expect(imageOf("<p>no image</p>")).toBeUndefined();
    expect(imageOf("")).toBeUndefined();
    expect(imageOf('<imgsrc="https://other.test/a.jpg">')).toBeUndefined();
    // Not a usable library image (too small): the next one.
    const tiny = upload("2024/05/t5.jpg", { width: 10, height: 10 });
    expect(
      imageOf(
        '<img src="/wp-content/uploads/2024/05/t5.jpg"><img src="https://other.test/b.jpg">',
        [tiny],
      )?.url,
    ).toBe("https://other.test/b.jpg");
    // The same address twice is looked up once; the first usable one wins.
    expect(
      imageOf('<img src="https://other.test/b.jpg"><img src="https://other.test/c.jpg">')?.url,
    ).toBe("https://other.test/b.jpg");
    // Something that is not an address at all.
    expect(imageOf('<img src="http://[bad">')).toBeUndefined();
  });

  test("the plugin's own memory of the content is trusted while the content is the same", () => {
    const a = upload("a1.jpg");
    const b = upload("b2.jpg");
    const content = '<img src="https://x.test/wp-content/uploads/a1.jpg">';
    const check = createHash("md5").update(content).digest("hex");
    // The cache names the other image: it is believed.
    expect(
      imageOf(content, [a, b], { rank_math_og_content_image: [{ check, images: [2] }] })?.id,
    ).toBe(2);
    // An address in the cache is an address.
    expect(
      imageOf(content, [a, b], {
        rank_math_og_content_image: [{ check, images: ["https://other.test/c.png"] }],
      })?.url,
    ).toBe("https://other.test/c.png");
    // A stale one, one for other content, and one that is not a cache: the content is read again.
    expect(
      imageOf(content, [a, b], {
        rank_math_og_content_image: [{ check: "0".repeat(32), images: [2] }],
      })?.id,
    ).toBe(1);
    expect(imageOf(content, [a, b], { rank_math_og_content_image: [{ images: [2] }] })?.id).toBe(1);
    expect(imageOf(content, [a, b], { rank_math_og_content_image: [{ check }] })?.id).toBe(1);
    expect(
      imageOf(content, [a, b], { rank_math_og_content_image: [{ check, images: "2" }] })?.id,
    ).toBe(1);
    expect(imageOf(content, [a, b], { rank_math_og_content_image: [[2]] })?.id).toBe(1);
    expect(imageOf(content, [a, b], { rank_math_og_content_image: ["x"] })?.id).toBe(1);
    // Junk in the list is skipped.
    expect(
      imageOf(content, [a, b], { rank_math_og_content_image: [{ check, images: [null, {}, 2] }] })
        ?.id,
    ).toBe(2);
    // A cached id that is no image, then the next.
    expect(
      imageOf(content, [a, b], { rank_math_og_content_image: [{ check, images: [99, 1] }] })?.id,
    ).toBe(1);
  });

  test("only a post looks in its content: a front page and the posts page do not", () => {
    const a = upload("a1.jpg");
    const front = wpPost({
      id: 10,
      type: "page",
      slug: "welcome",
      title: "Welcome",
      content: '<img src="https://x.test/wp-content/uploads/a1.jpg">',
    });
    const model = modelOf([front], {
      site: { showOnFront: "page", pageOnFront: 10, pageForPosts: 10 },
      attachments: [a],
    });
    expect(seoFor(model, { kind: "home" }).image).toBeUndefined();
    expect(seoFor(model, { kind: "posts-page" }).image).toBeUndefined();
    expect(seoFor(model, { kind: "post", post: front }).image?.id).toBe(1);
  });
});

// ── Social ───────────────────────────────────────────────────────────────────────────────────────

describe("Open Graph and Twitter, the fields one at a time", () => {
  const social = (
    meta: Record<string, unknown> = {},
    titles: Record<string, unknown> = {},
    post: Partial<WpPost> = {},
    parts: Parts = {},
  ): Seo =>
    seoOfPost(post, {
      ...parts,
      titles,
      postMeta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [`rank_math_${k}`, [v]])),
    });

  test("the Twitter card: the post's, else the site's, else the small one, and only a kind that exists", () => {
    for (const card of ["summary", "summary_large_image", "app", "player"]) {
      expect(social({ twitter_card_type: card }).twitter.card).toBe(card);
      expect(social({}, { twitter_card_type: card }).twitter.card).toBe(card);
    }
    expect(social().twitter.card).toBe("summary");
    expect(social({ twitter_card_type: "gallery" }).twitter.card).toBe("summary");
    expect(social({}, { twitter_card_type: "gallery" }).twitter.card).toBe("summary");
    expect(social({ twitter_card_type: "player" }, { twitter_card_type: "app" }).twitter.card).toBe(
      "player",
    );
    expect(social({ twitter_card_type: "" }, { twitter_card_type: "app" }).twitter.card).toBe(
      "app",
    );
    const term = wpTerm({
      termId: 60,
      taxonomy: "genre",
      meta: { rank_math_twitter_card_type: "player" },
    });
    const model = (titles: Record<string, unknown>) => modelOf([], { terms: [term], titles });
    expect(seoFor(model({}), { kind: "term", term }).twitter.card).toBe("player");
    expect(
      seoFor(model({ twitter_card_type: "app" }), { kind: "term", term: { ...term, meta: {} } })
        .twitter.card,
    ).toBe("app");
    expect(
      seoFor(model({ twitter_card_type: "bogus" }), { kind: "term", term: { ...term, meta: {} } })
        .twitter.card,
    ).toBe("summary");
    expect(
      seoFor(model({ twitter_card_type: "player" }), { kind: "archive", postType: "book" }).twitter
        .card,
    ).toBe("player");
    expect(
      seoFor(model({ twitter_card_type: "bogus" }), { kind: "archive", postType: "book" }).twitter
        .card,
    ).toBe("summary");
    expect(seoFor(model({ twitter_card_type: "app" }), { kind: "home" }).twitter.card).toBe("app");
    expect(seoFor(model({ twitter_card_type: "bogus" }), { kind: "home" }).twitter.card).toBe(
      "summary",
    );
  });

  test("the social title and description: the page's own, with the variables replaced, else the page's", () => {
    const seo = social(
      {
        facebook_title: "FB %title% &amp; co",
        facebook_description: "FB &quot;desc&quot;",
        twitter_title: "TW %title%",
        twitter_description: "TW desc",
      },
      {},
      { title: "the post" },
    );
    expect(seo.title).toBe("the post - X Site");
    expect(seo.openGraph).toMatchObject({ title: "FB the post & co", description: 'FB "desc"' });
    expect(seo.twitter).toMatchObject({ title: "TW the post", description: "TW desc" });
    // With the same titles on, capitals apply to the titles and not the descriptions.
    const caps = social(
      {
        facebook_title: "fb title",
        facebook_description: "fb description",
        twitter_title: "tw title",
        twitter_description: "tw description",
      },
      { capitalize_titles: "on" },
    );
    expect(caps.openGraph).toMatchObject({ title: "Fb Title", description: "fb description" });
    expect(caps.twitter).toMatchObject({ title: "Tw Title", description: "tw description" });
    // Twitter takes Facebook's when it is told to.
    const shared = social({
      facebook_title: "FB",
      facebook_description: "FBD",
      twitter_title: "TW",
      twitter_description: "TWD",
      twitter_use_facebook: "on",
    });
    expect(shared.twitter).toMatchObject({ title: "FB", description: "FBD" });
    // Nothing of their own: the page's.
    const plain = social({}, {}, { title: "t", excerpt: "an excerpt" });
    expect(plain.openGraph).toMatchObject({ title: "t - X Site", description: "an excerpt" });
    expect(plain.twitter).toMatchObject({ title: "t - X Site", description: "an excerpt" });
  });

  test("the same, for a term and for the home page", () => {
    const term = wpTerm({
      termId: 60,
      taxonomy: "genre",
      name: "Jazz",
      meta: {
        rank_math_facebook_title: "fb %term%",
        rank_math_facebook_description: "fb d &amp;",
        rank_math_twitter_title: "tw %term%",
        rank_math_twitter_description: "tw d",
      },
    });
    const model = modelOf([], {
      terms: [term],
      titles: { tax_genre_title: "%term%", capitalize_titles: "on" },
    });
    const seo = seoFor(model, { kind: "term", term });
    expect(seo.openGraph).toMatchObject({ title: "Fb Jazz", description: "fb d &" });
    expect(seo.twitter).toMatchObject({ title: "Tw Jazz", description: "tw d" });
    const own = { ...term, meta: { ...term.meta, rank_math_twitter_use_facebook: "on" } };
    expect(
      seoFor(modelOf([], { terms: [own] }), { kind: "term", term: own }).twitter,
    ).toMatchObject({
      title: "fb Jazz",
      description: "fb d &",
    });
    const home = modelOf([], {
      titles: {
        homepage_title: "H",
        homepage_description: "HD",
        homepage_facebook_title: "social %sitename%",
        homepage_facebook_description: "social &amp; d",
        capitalize_titles: "on",
      },
    });
    const h = seoFor(home, { kind: "home" });
    expect(h.openGraph).toMatchObject({ title: "Social X Site", description: "social & d" });
    expect(h.twitter).toMatchObject({ title: "H", description: "HD" });
  });

  test("the site: its name, locale, handle and the address of the page", () => {
    expect(social().openGraph).toMatchObject({
      siteName: "X Site",
      locale: "en_US",
      type: "article",
    });
    expect(social({}, { website_name: "Acme &amp; Co" }).openGraph.siteName).toBe("Acme & Co");
    expect(social({}, { website_name: "<b>Acme</b>\n Co" }).openGraph.siteName).toBe("Acme Co");
    expect(social({}, {}, {}, { site: { language: "pt-BR" } }).openGraph.locale).toBe("pt_BR");
    expect(social().twitter.site).toBeUndefined();
    expect(social({}, { twitter_author_names: "acme" }).twitter.site).toBe("@acme");
    const at = (target: SeoTarget): Seo =>
      seoFor(modelOf([]), target, { permalink: () => "https://x.test/the-page/" });
    // The canonical is the page's own address, or what a person set.
    const post = wpPost();
    const model = modelOf([post]);
    const opts = { permalink: () => "https://x.test/the-page/" };
    expect(seoFor(model, { kind: "post", post }, opts)).toMatchObject({
      canonical: "https://x.test/the-page/",
      openGraph: { url: "https://x.test/the-page/" },
    });
    expect(seoFor(model, { kind: "post", post }).canonical).toBeUndefined();
    expect(seoFor(model, { kind: "post", post }).openGraph.url).toBeUndefined();
    const own = seoOfPost(
      {},
      { postMeta: { rank_math_canonical_url: ["https://elsewhere.test/"] } },
      opts,
    );
    expect(own).toMatchObject({
      canonical: "https://elsewhere.test/",
      openGraph: { url: "https://elsewhere.test/" },
    });
    // A noindex page prints no canonical, and its og:url stays.
    const hidden = seoOfPost({}, { postMeta: { rank_math_robots: [["noindex"]] } }, opts);
    expect(hidden.canonical).toBeUndefined();
    expect(hidden.openGraph.url).toBe("https://x.test/the-page/");
    expect(at({ kind: "home" }).canonical).toBe("https://x.test/the-page/");
    // The permalink function is asked about the target it was given.
    const asked: string[] = [];
    seoFor(model, { kind: "post", post }, { permalink: (t) => (asked.push(t.kind), undefined) });
    expect(asked).toEqual(["post"]);
  });
});

// ── Routing, and where things are reported ──────────────────────────────────────────────────────

describe("seoFor: which paper a target is, and where a report says it was found", () => {
  const dangling = { open_graph_image_id: "404" };

  test("every kind of target names itself in a report", () => {
    const post = wpPost({ id: 800, status: "publish" });
    const draft = wpPost({ id: 801, status: "draft" });
    const term = wpTerm({ termId: 60, taxonomy: "genre" });
    const where = (target: SeoTarget, parts: Parts = {}): { where?: string; url?: string } => {
      const report = createReport();
      const model = modelOf([post, draft], { terms: [term], titles: dangling, ...parts });
      seoFor(model, target, { report });
      const found = codes(report, "seo.image-unresolved")[0]!;
      return {
        ...(found.where === undefined ? {} : { where: found.where }),
        ...(found.url === undefined ? {} : { url: found.url }),
      };
    };
    expect(where({ kind: "post", post })).toEqual({
      where: "post:800",
      url: "https://x.test/?p=800",
    });
    expect(where({ kind: "post", post: draft })).toEqual({ where: "post:801" });
    expect(where({ kind: "term", term })).toEqual({ where: "term:60" });
    expect(where({ kind: "archive", postType: "book" })).toEqual({ where: "archive:book" });
    expect(where({ kind: "home" })).toEqual({ where: "home", url: "https://x.test" });
    expect(where({ kind: "posts-page" })).toEqual({ where: "home", url: "https://x.test" });
  });

  test("a static front page and posts page are posts, and the latest-posts front page is the blog's", () => {
    const front = wpPost({ id: 10, type: "page", slug: "front", title: "Front" });
    const news = wpPost({ id: 11, type: "page", slug: "news", title: "News" });
    const model = modelOf([front, news], {
      site: { showOnFront: "page", pageOnFront: 10, pageForPosts: 11 },
      titles: { pt_page_title: "PAGE %title%", homepage_title: "BLOG" },
    });
    expect(seoFor(model, { kind: "home" }).title).toBe("PAGE Front");
    expect(seoFor(model, { kind: "posts-page" }).title).toBe("PAGE News");
    const latest = modelOf([front, news], {
      site: { showOnFront: "posts", pageOnFront: 10, pageForPosts: 11 },
      titles: { pt_page_title: "PAGE %title%", homepage_title: "BLOG" },
    });
    expect(seoFor(latest, { kind: "home" }).title).toBe("BLOG");
    expect(seoFor(latest, { kind: "posts-page" }).title).toBe("BLOG");
    // The page-for-posts has no content image of its own role, and is typed as a website.
    expect(seoFor(model, { kind: "posts-page" }).openGraph.type).toBe("website");
    expect(seoFor(latest, { kind: "home" }).openGraph.type).toBe("website");
    expect(seoFor(model, { kind: "archive", postType: "post" }).openGraph.type).toBe("article");
  });

  test("a front page that is not in the model is reported at the right option", () => {
    const report = createReport();
    const model = modelOf([], { site: { showOnFront: "page", pageOnFront: 10, pageForPosts: 11 } });
    seoFor(model, { kind: "home" }, { report });
    seoFor(model, { kind: "posts-page" }, { report });
    expect(
      codes(report, "seo.target-missing").map((e) => [e.where, e.message.includes("front page")]),
    ).toEqual([
      ["option:page_on_front", true],
      ["option:page_for_posts", false],
    ]);
    expect(codes(report, "seo.target-missing")[1]!.message).toContain("posts page (11)");
  });
});
// </batch2>

// <batch3>

// ── What the first mutation run found missing ────────────────────────────────────────────────────

describe("truncation, at the edges (PHP's own answers)", () => {
  const long = "aaaaaaaaa ".repeat(13);
  const VECTORS: [string, number | undefined, string][] = [
    ["&&abcdef", 10, ""],
    ["&&abcdef", 8, ""],
    ["x &&abcdef", 20, "x"],
    [long, 110, "aaaaaaaaa ".repeat(9) + "aaaaaaaaa"],
    [long, 111, "aaaaaaaaa ".repeat(10) + "aaaaaaaaa"],
    [long, 109, "aaaaaaaaa ".repeat(9) + "aaaaaaaaa"],
    [long, undefined, "aaaaaaaaa ".repeat(9) + "aaaaaaaaa"],
    ["short text", 110, "short text"],
    ["é".repeat(40) + " tail", 30, ""],
    ["a &amp b", 4, ""],
    ["a &ampx b", 6, ""],
  ];
  test("each against Rank Math's Str::truncate", () => {
    for (const [input, length, expected] of VECTORS)
      expect({ input, length, got: php.truncate(input, length) }).toEqual({
        input,
        length,
        got: expected,
      });
  });
});

describe("more settings, as Rank Math reads them", () => {
  test("a switch that is on reads as 1 where it is text, and one that is off as nothing", () => {
    const sep = (value: unknown): string =>
      seoOfPost({ title: "T" }, { titles: { pt_post_title: "[%sep%]", title_separator: value } })
        .title;
    expect(sep("on")).toBe("[1]");
    expect(sep("true")).toBe("[1]");
    expect(sep("off")).toBe("[]");
    expect(sep("false")).toBe("[]");
    expect(sep("0")).toBe("[0]");
    expect(sep("1")).toBe("[1]");
    expect(sep(["x"])).toBe("[]");
  });

  test("the missing settings are reported only when there are none", () => {
    const post = wpPost({ title: "T" });
    const report = createReport();
    seoFor(modelOf([post]), { kind: "post", post }, { report });
    expect(codes(report, "seo.settings-missing")).toEqual([]);
    // One setting is enough to be there.
    const one = modelOf([post], { noTitles: true });
    const options = new Map(one.options);
    options.set("rank-math-options-titles", serialize({ title_separator: "-" }));
    const quiet = createReport();
    seoFor({ ...one, options }, { kind: "post", post }, { report: quiet });
    expect(codes(quiet, "seo.settings-missing")).toEqual([]);
    // A list is not a set of settings, and neither is text.
    for (const junk of [serialize(["a"]), "not serialised", serialize("x")]) {
      const bad = new Map(one.options);
      bad.set("rank-math-options-titles", junk);
      const loud = createReport();
      seoFor({ ...one, options: bad }, { kind: "post", post }, { report: loud });
      expect(codes(loud, "seo.settings-missing")).toHaveLength(1);
    }
  });

  test("a list with one thing in it is something", () => {
    const robots = (meta: unknown): string =>
      seoOfPost({}, { postMeta: { rank_math_advanced_robots: [meta] } }).robots;
    expect(robots(["max-snippet:5"])).toBe("follow, index");
    expect(robots([])).toBe(
      "follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
    );
  });
});

describe("the variables, the cases the first pass left", () => {
  const author: WpUser = { id: 1, slug: "one", displayName: "Author One" };
  const render = (
    template: string,
    post: Partial<WpPost> = {},
    parts: Parts & { postMeta?: Record<string, unknown[]> } = {},
    opts: Parameters<typeof seoFor>[2] = {},
  ): string => {
    const p = wpPost({ id: 900, ...post });
    const model = modelOf([p, wpPost({ id: 1, title: "Page One", type: "page" })], {
      ...parts,
      titles: { [`pt_${post.type ?? "post"}_title`]: template, ...parts.titles },
      meta: { 900: parts.postMeta ?? {} },
    });
    return seoFor(model, { kind: "post", post: p }, opts).title;
  };

  test("a parent and an author with the id 1 are real ones, and 0 is none", () => {
    expect(render("%parent_title%", { parent: 1 })).toBe("Page One");
    expect(render("%userid% %name%", { authorId: 1 }, { users: [author] })).toBe("1 Author One");
    expect(render("[%userid%]", { authorId: 0 }, { users: [author] })).toBe("[]");
  });

  test("an excerpt or content of `0` is empty, as PHP's empty() has it", () => {
    expect(render("[%excerpt%]", { excerpt: "0", content: "<p>Body</p>" })).toBe("[Body]");
    expect(render("[%excerpt%]", { content: "0" })).toBe("[]");
    expect(render("[%excerpt%]", { content: "[caption]x[/caption]" })).toBe("[]");
  });

  test("terms: an empty separator joins them as they are, and a hundred terms are cut to ninety-nine", () => {
    const cats = ["Zebra", "Apple", "Mango"].map((name, i) =>
      wpTerm({ termId: i + 1, taxonomy: "category", name }),
    );
    expect(render("%categories(separator=)%", {}, { terms: cats, rel: { 900: [1, 2, 3] } })).toBe(
      "AppleMangoZebra",
    );
    expect(
      render("%categories(limit=2&separator=)%", {}, { terms: cats, rel: { 900: [1, 2, 3] } }),
    ).toBe("AppleMango");
    const many = Array.from({ length: 120 }, (_, i) =>
      wpTerm({ termId: i + 1, taxonomy: "post_tag", name: `tag${String(i).padStart(3, "0")}` }),
    );
    const rel = { 900: many.map((t) => t.termId) };
    const all = render("%tags%", {}, { terms: many, rel }).split(", ");
    expect(all).toHaveLength(99);
    expect(all[98]).toBe("tag098");
    expect(render("%tags(limit=100)%", {}, { terms: many, rel }).split(", ")).toHaveLength(100);
  });

  test("a custom taxonomy gives its first term by name, and an author's id 1 is no id", () => {
    const genres = ["Swing", "Bebop", "Cool"].map((name, i) =>
      wpTerm({ termId: i + 1, taxonomy: "genre", name, description: `${name} d` }),
    );
    const parts = { terms: genres, rel: { 900: [1, 2, 3] } };
    expect(render("%customterm(genre)%", {}, parts)).toBe("Bebop");
    expect(render("%customterm_desc(genre)%", {}, parts)).toBe("Bebop d");
  });

  test("%url% is asked for the term and for the home page too", () => {
    const seen: string[] = [];
    const term = wpTerm({ termId: 60, taxonomy: "genre" });
    const model = modelOf([], {
      terms: [term],
      titles: { tax_genre_title: "%url%", homepage_title: "%url%" },
    });
    const permalink = (t: SeoTarget): string | undefined => (
      seen.push(t.kind),
      `https://x.test/${t.kind}/`
    );
    expect(seoFor(model, { kind: "term", term }, { permalink }).title).toBe("https://x.test/term/");
    expect(seoFor(model, { kind: "home" }, { permalink }).title).toBe("https://x.test/home/");
    expect(seen).toContain("term");
    expect(seen).toContain("home");
  });

  test("the five clock variables are each a dynamic one", () => {
    for (const name of [
      "currentdate",
      "currentday",
      "currentmonth",
      "currentyear",
      "currenttime",
    ]) {
      const report = createReport();
      render(`%${name}%`, {}, {}, { report });
      expect(codes(report, "seo.dynamic-variable").map((e) => e.data)).toEqual([
        { variable: name },
      ]);
    }
    const report = createReport();
    render("%categories% %title%", {}, {}, { report });
    expect(codes(report, "seo.dynamic-variable")).toEqual([]);
  });

  test("the current time knows the offset and the zone of the site", () => {
    const now = new Date("2026-07-02T14:05:09Z");
    const at = (format: string, options: Record<string, string>): string =>
      render(`%currenttime(${format})%`, {}, { options }, { now });
    const ny = { timezone_string: "America/New_York" };
    expect(at("P O Z T I e", ny)).toBe("-04:00 -0400 -14400 EDT 1 America/New_York");
    expect(at("P O Z T I", { timezone_string: "America/New_York" })).toBe(
      "-04:00 -0400 -14400 EDT 1",
    );
    expect(
      render("%currenttime(P I)%", {}, { options: ny }, { now: new Date("2026-01-02T14:05:09Z") }),
    ).toBe("-05:00 0");
    expect(at("P O Z", { timezone_string: "Asia/Kolkata" })).toBe("+05:30 +0530 19800");
  });

  test("a description is one line", () => {
    const description = (excerpt: string): string => seoOfPost({ excerpt }).description;
    expect(description("Line one\nline\ttwo  three")).toBe("Line one line two three");
    expect(description("<p>Para</p>\n<p>graph</p>")).toBe("Para graph");
  });
});

describe("robots, the cases the first pass left", () => {
  const ADVANCED = "max-snippet:-1, max-video-preview:-1, max-image-preview:large";
  const robots = (
    meta: Record<string, unknown>,
    titles: Record<string, unknown>,
    post: Partial<WpPost> = {},
    options: Record<string, string> = {},
  ): string =>
    seoOfPost(post, {
      titles,
      options,
      postMeta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [`rank_math_${k}`, [v]])),
    }).robots;

  test("Rank Math's own pair, index first, can still be made noindex", () => {
    expect(robots({}, { robots_global: [] }, {}, { blog_public: "0" })).toBe("noindex, nofollow");
    expect(robots({}, { robots_global: [] }, { status: "private" })).toBe("follow, noindex");
    expect(robots({}, { pt_post_custom_robots: "on" }, { status: "private" })).toBe(
      "noindex, follow",
    );
    expect(
      robots(
        {},
        { pt_post_custom_robots: "on", noindex_password_protected: "on" },
        { passwordProtected: true },
      ),
    ).toBe("noindex, follow");
    expect(robots({}, { pt_post_custom_robots: "on" }, {}, { blog_public: "0" })).toBe(
      "noindex, nofollow",
    );
    expect(robots({ robots: ["index"] }, {}, { status: "private" })).toBe("follow, noindex");
  });

  test("the directives of the page and the advanced ones are kept apart", () => {
    // `max-snippet` is no robots directive, whatever list it is in.
    expect(robots({ robots: ["max-snippet:5", "noarchive"] }, {})).toBe(
      `follow, index, noarchive, ${ADVANCED}`,
    );
  });
});

describe("images, the cases the first pass left", () => {
  const att = (o: Partial<WpAttachment> & { id: number }): WpAttachment =>
    wpAttachment({ file: "pic.jpg", url: "https://x.test/wp-content/uploads/pic.jpg", ...o });
  const featured = (attachment: WpAttachment, parts: Parts = {}): Seo["image"] =>
    seoOfPost(
      {},
      { ...parts, attachments: [attachment], postMeta: { _thumbnail_id: [String(attachment.id)] } },
    ).image;
  const imageOf = (
    content: string,
    attachments: WpAttachment[] = [],
    meta: Record<string, unknown[]> = {},
  ): Seo["image"] => seoOfPost({ content }, { attachments, postMeta: meta }).image;

  test("AVIF is an image, and a size of 1 pixel is a size", () => {
    expect(
      featured(
        att({
          id: 1,
          file: "p.avif",
          url: "https://x.test/wp-content/uploads/p.avif",
          mime: "image/avif",
          width: 800,
          height: 600,
        }),
      ),
    ).toMatchObject({ type: "image/avif" });
    expect(
      featured(att({ id: 1, width: 3000, height: 2000 }), {
        options: { large_size_w: "1", large_size_h: "1" },
      }),
    ).toMatchObject({
      width: 768,
      height: 512,
    });
    expect(
      featured(att({ id: 1, width: 3000, height: 2000 }), { options: { large_size_w: "1" } }),
    ).toMatchObject({ width: 768 });
  });

  test("a file the library keeps with its folder in the name is found by the path of its address", () => {
    const kept = att({
      id: 3,
      file: "wp-content/uploads/2024/k3.jpg",
      url: "https://x.test/?attachment_id=3",
      width: 800,
      height: 600,
    });
    expect(imageOf('<img src="https://x.test/wp-content/uploads/2024/k3.jpg">', [kept])?.id).toBe(
      3,
    );
    // On another host it is not the same file.
    const elsewhere = att({
      id: 3,
      file: "wp-content/uploads/2024/k3.jpg",
      url: "https://media.test/?attachment_id=3",
      width: 800,
      height: 600,
    });
    expect(
      imageOf('<img src="https://x.test/wp-content/uploads/2024/k3.jpg">', [elsewhere])?.id,
    ).toBeUndefined();
  });

  test("an address that is not one is not an image, and finds no attachment", () => {
    const one = att({ id: 1, width: 800, height: 600 });
    expect(imageOf('<img src="http://[bad">', [one])).toBeUndefined();
    expect(imageOf('<img src="http://[bad.jpg">', [one])).toBeUndefined();
    expect(
      imageOf('<img src="http://[bad.jpg"><img src="https://other.test/ok.png">', [one])?.url,
    ).toBe("https://other.test/ok.png");
  });
});

describe("a page that is not in the model names where its reports come from", () => {
  test("the front page and the posts page", () => {
    const sf = { site: { showOnFront: "page" as const, pageOnFront: 10, pageForPosts: 11 } };
    for (const [kind, where] of [
      ["home", "home"],
      ["posts-page", "posts-page"],
    ] as const) {
      const report = createReport();
      seoFor(modelOf([], { ...sf, titles: { open_graph_image_id: "404" } }), { kind }, { report });
      expect(codes(report, "seo.image-unresolved")[0]!.where).toBe(where);
    }
  });
});

describe("the template engine and the lists, the cases the second pass left", () => {
  test("a variable that has an `_args` twin reads it only when it is given arguments", () => {
    const vars: RankMathVars = { categories_args: (a) => `twin(${a})` };
    expect(renderRankMathTemplate("[%categories%]", vars)).toBe("[]");
    expect(renderRankMathTemplate("[%categories(x=1)%]", vars)).toBe("[twin(x=1)]");
    const plain: RankMathVars = { categories: () => "plain", categories_args: () => "twin" };
    expect(renderRankMathTemplate("[%categories%] [%categories(x=1)%]", plain)).toBe(
      "[plain] [plain]",
    );
  });

  test("two terms with one name keep the order the post has them in", () => {
    const post = wpPost({ id: 900 });
    const same = [1, 2, 3].map((id) =>
      wpTerm({ termId: id, taxonomy: "genre", name: "Same", description: `d${id}` }),
    );
    const model = modelOf([post], {
      terms: same,
      rel: { 900: [1, 2, 3] },
      titles: { pt_post_title: "%customterm_desc(genre)% / %customterm(genre)%" },
    });
    expect(seoFor(model, { kind: "post", post }).title).toBe("d1 / Same");
  });

  test("a picture on a media host, named by its own address, is an address and not a library file", () => {
    const cdn = wpAttachment({
      id: 5,
      file: "2024/pic.jpg",
      url: "https://media.x.test/2024/pic.jpg",
      width: 800,
      height: 600,
      alt: "In the library",
    });
    const seo = seoOfPost(
      { content: '<img src="https://media.x.test/2024/pic.jpg">' },
      { attachments: [cdn] },
    );
    expect(seo.image).toEqual({ url: "https://media.x.test/2024/pic.jpg", alt: "A Post" });
  });
});
// </batch3>

// <batch4>

describe("the edges the second mutation run found", () => {
  test("strip_tags: an instruction that opens with `<?xml` is a tag, anything else with those letters in it is not (PHP's own answers)", () => {
    const VECTORS: [string, string][] = [
      ["a<?xml x>y", "ay"],
      ["<?xml x>y", ""],
      ["<?php xml)>E", ""],
      ["<?ab<?xml x>y", "y"],
      ["<?ab<?XmL x>y", "y"],
      ["<?abc?xml x>y", ""],
      // The `xml` mode ends with its tag: a later tag may end in `->`.
      ["a<?xml x>b <i ->c", "ab c"],
      ["a<?xml x>b <i ->c>d", "ab c>d"],
      ["<?ab<?xml x>y <i ->c", "y c"],
    ];
    for (const [input, expected] of VECTORS)
      expect({ input, got: php.stripTags(input) }).toEqual({ input, got: expected });
  });

  test("kses: a comment that WordPress filters for ever is filtered a bounded number of times", () => {
    // WordPress loops on this input without end (`while ( wp_kses( $content ) != $content )`); each round here
    // adds a `&gt;`, and the bound stops it after 64 rounds: the first round turns the opener into one, the rest add
    // sixty-two more.
    expect(php.ksesParagraphs("<p><!--></<i></p>")).toBe(
      `<p><!--&gt;</&gt;</p>>${"&gt;".repeat(62)}-->`,
    );
  });

  test("a term and the home page have no thumbnail, whatever attachment has the id 1", () => {
    const one = wpAttachment({
      id: 1,
      file: "one.jpg",
      url: "https://x.test/wp-content/uploads/one.jpg",
    });
    const term = wpTerm({ termId: 60, taxonomy: "genre" });
    const model = modelOf([], {
      attachments: [one],
      terms: [term],
      titles: { tax_genre_title: "[%post_thumbnail%]", homepage_title: "[%post_thumbnail%]" },
    });
    expect(seoFor(model, { kind: "term", term }).title).toBe("[]");
    expect(seoFor(model, { kind: "home" }).title).toBe("[]");
  });

  test("one line break in a title is a space", () => {
    expect(seoOfPost({ title: "One\ntwo\tthree" }).title).toBe("One two three - X Site");
  });

  test("a site that shows its latest posts has no front page to miss", () => {
    const report = createReport();
    const model = modelOf([], { titles: { homepage_title: "H" } });
    expect(seoFor(model, { kind: "home" }, { report }).title).toBe("H");
    expect(seoFor(model, { kind: "posts-page" }, { report }).title).toBe("H");
    expect(codes(report, "seo.target-missing")).toEqual([]);
  });
});
// </batch4>

// <review-fixes>
describe("review findings: template values are text, not replacement patterns", () => {
  // PHP's str_replace has no replacement syntax; JS's string replacement expands $$, $&, $' and $`.
  const dollars = [
    "Cheap $$ deals",
    "Save $& more",
    "Cost: $5 or $'x",
    "Price $` here",
    "$$$ Rich $$$",
  ];
  for (const title of dollars) {
    test(JSON.stringify(title), () => {
      expect(renderRankMathTemplate("%title% %sep% Site", { title, sep: "-" })).toBe(
        `${title} - Site`,
      );
      expect(seoOfPost({ title }).title).toBe(`${title} - X Site`);
    });
  }

  test("a variable that appears twice, and a value that holds another variable's name", () => {
    expect(renderRankMathTemplate("%title% %title%", { title: "a$&b" })).toBe("a$&b a$&b");
    expect(
      renderRankMathTemplate("%title% %sitename%", { title: "$%sitename%", sitename: "S" }),
    ).toBe("$S S");
  });
});

describe("review findings: the social image sits where its attachment's guid says", () => {
  const scaled = (o: Partial<WpAttachment> = {}): WpAttachment =>
    wpAttachment({
      id: 7,
      url: "https://media.x.test/Cover-1.png",
      file: "Cover-1-scaled.png",
      mime: "image/png",
      width: 2560,
      height: 2560,
      sizes: [
        { name: "large", file: "Cover-1-1024x1024.png", width: 1024, height: 1024 },
        { name: "medium_large", file: "Cover-1-768x768.png", width: 768, height: 768 },
      ],
      ...o,
    });
  const imageOf = (att: WpAttachment): string | undefined =>
    seoOfPost({}, { attachments: [att], postMeta: { _thumbnail_id: ["7"] } }).image?.url;

  test("a -scaled copy keeps the host of the guid it was made from", () => {
    expect(imageOf(scaled())).toBe("https://media.x.test/Cover-1-1024x1024.png");
  });

  test("the full size, when it is small enough, is named by the attached file on the guid's host", () => {
    expect(imageOf(scaled({ width: 1500, height: 1500 }))).toBe(
      "https://media.x.test/Cover-1-scaled.png",
    );
  });

  test("an uploads guid with a dated folder keeps that folder and host", () => {
    const att = scaled({
      url: "https://cdn.x.test/wp-content/uploads/2024/05/Cover-1.png",
      file: "2024/05/Cover-1-e1719665859529.png",
      width: 1500,
      height: 1500,
    });
    expect(imageOf(att)).toBe(
      "https://cdn.x.test/wp-content/uploads/2024/05/Cover-1-e1719665859529.png",
    );
  });

  test("a guid in some other folder than the file's falls back to the site's uploads", () => {
    const att = scaled({
      url: "https://cdn.x.test/elsewhere/Cover-1.png",
      file: "2024/05/Cover-1.png",
      width: 1500,
      height: 1500,
    });
    expect(imageOf(att)).toBe("https://x.test/wp-content/uploads/2024/05/Cover-1.png");
  });

  test("every anabaptistperspectives attachment is served from its own guid's host", () => {
    const model = models.ap;
    const odd = [...model.attachments.values()].filter(
      (a) => a.mime.startsWith("image/") && !a.url.endsWith(a.file) && /^https?:/.test(a.url),
    );
    expect(odd.length).toBeGreaterThan(5);
    let checked = 0;
    for (const att of odd) {
      const seo = seoOfPost(
        {},
        { attachments: [{ ...att, id: 7 }], postMeta: { _thumbnail_id: ["7"] } },
      );
      if (!seo.image) continue;
      checked++;
      expect(new URL(seo.image.url).host).toBe(new URL(att.url).host);
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("review findings: a password-protected post has no social image", () => {
  const att = wpAttachment({ id: 7, file: "a.jpg", width: 800, height: 600 });
  const parts = {
    attachments: [att],
    titles: { open_graph_image_id: "7" },
    postMeta: { _thumbnail_id: ["7"] },
  };
  test("the public post has one", () => {
    const seo = seoOfPost({}, parts);
    expect(seo.image?.url).toBe("https://x.test/wp-content/uploads/a.jpg");
    expect(seo.twitter.image?.url).toBe("https://x.test/wp-content/uploads/a.jpg");
  });
  test("the protected one has none, not even the site's default", () => {
    const seo = seoOfPost({ passwordProtected: true }, parts);
    expect(seo.image).toBeUndefined();
    expect(seo.openGraph.image).toBeUndefined();
    expect(seo.twitter.image).toBeUndefined();
  });
  test("the protected one has none from its own facebook image either", () => {
    const seo = seoOfPost(
      { passwordProtected: true },
      {
        ...parts,
        postMeta: { rank_math_facebook_image_id: ["7"], rank_math_twitter_image_id: ["7"] },
      },
    );
    expect(seo.image).toBeUndefined();
    expect(seo.twitter.image).toBeUndefined();
  });
});

describe("review findings: names that are Object.prototype members", () => {
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    test(`an archive of post type "${type}" is labelled by its own name`, () => {
      const model = modelOf([], {
        titles: { [`pt_${type}_archive_title`]: "%pt_plural% %sep% %sitename%" },
      });
      const seo = seoFor(model, { kind: "archive", postType: type });
      expect(seo.title).toBe(`${type} - X Site`);
    });
  }
});

describe("review findings: terms are ordered as MySQL's case-insensitive collation orders them", () => {
  const terms = [
    wpTerm({ termId: 1, name: "Banana", slug: "banana" }),
    wpTerm({ termId: 2, name: "apple", slug: "apple" }),
    wpTerm({ termId: 3, name: "Éclair", slug: "eclair-a" }),
    wpTerm({ termId: 4, name: "eclair", slug: "eclair-b" }),
  ];
  test("%category% and %categories%", () => {
    const post = wpPost({ title: "T" });
    const model = modelOf([post], {
      terms,
      rel: { [post.id]: [1, 2, 3, 4] },
      titles: { pt_post_title: "%category% | %categories% %sep% %sitename%" },
    });
    // apple, Banana, then the two éclairs, which the collation treats as equal: by id.
    expect(seoFor(model, { kind: "post", post }).title).toBe(
      "apple | apple, Banana, Éclair, eclair - X Site",
    );
  });
});

describe("review findings: titles go through convert_smilies, as Rank Math does", () => {
  // PHP: html_entity_decode( convert_smilies( esc_html( $title ) ) ), WordPress 6.8 with use_smilies on.
  const cases: [string, string][] = [
    ["Hello :) world", "Hello \u{1F642} world"],
    ["Top 8) picks", "Top 8) picks"],
    ["A :arrow: B", "A ➡ B"],
    ["Ok :-) bye", "Ok \u{1F642} bye"],
    ["Q&A :D", "Q&A \u{1F600}"],
    ["x:)", "x:)"],
    ["a  :) b", "a \u{1F642} b"],
    [" :) x", " \u{1F642} x"],
  ];
  for (const [title, want] of cases) {
    test(JSON.stringify(title), () => {
      // (`- X Site` follows: the smiley must be followed by a space or the end, and it is.)
      const got = seoOfPost(
        { title },
        { options: { use_smilies: "1" }, titles: { pt_post_title: "%title%" } },
      );
      expect(got.title).toBe(want);
    });
  }
  test("a site with smilies off keeps the text", () => {
    const off = seoOfPost(
      { title: "Hello :) world" },
      { options: { use_smilies: "0" }, titles: { pt_post_title: "%title%" } },
    );
    expect(off.title).toBe("Hello :) world");
    expect(
      seoOfPost({ title: "Hello :) world" }, { titles: { pt_post_title: "%title%" } }).title,
    ).toBe("Hello :) world");
  });
  test(":mrgreen: is an image of the site's own", () => {
    const got = seoOfPost(
      { title: "Yay :mrgreen:" },
      { options: { use_smilies: "1" }, titles: { pt_post_title: "%title%" } },
    );
    expect(got.title).toBe(
      'Yay <img src="https://x.test/wp-includes/images/smilies/mrgreen.png" alt=":mrgreen:" class="wp-smiley" style="height: 1em; max-height: 1em;" />',
    );
  });
  test("the term and archive titles too", () => {
    const term = wpTerm({ termId: 60, taxonomy: "genre", name: "Fun :)" });
    const model = modelOf([], {
      terms: [term],
      options: { use_smilies: "1" },
      titles: { tax_genre_title: "%term%" },
    });
    expect(seoFor(model, { kind: "term", term }).title).toBe("Fun \u{1F642}");
  });
});
const TYPO_FRAGMENTS: readonly string[] = [
  "'",
  "'",
  '"',
  '"',
  "''",
  "``",
  "...",
  "..",
  "-",
  "--",
  "---",
  " - ",
  " -- ",
  "xn--",
  "9",
  "99",
  "'99",
  "0",
  "7'",
  '7"',
  "3x4",
  "0x99",
  "x",
  " ",
  " ",
  " ",
  "a",
  "b",
  "word",
  "Trump's",
  "'tis",
  "'em",
  "'cause",
  "(tm)",
  " (tm)",
  "&",
  "&amp;",
  "&lt;",
  "&gt;",
  "&#8217;",
  "&nbsp;",
  " ",
  "\n",
  ".",
  ",",
  ":",
  ";",
  "!",
  "?",
  ")",
  "(",
  "[",
  "]",
  "{",
  "}",
  "<b>",
  "</b>",
  "<code>",
  "</code>",
  "<pre>",
  "</pre>",
  "<!-- c -->",
  '<a href="x">',
  "</a>",
  "<",
  ">",
  "%",
  "1.5",
  "Wordpress",
  "é",
  "<script>",
  "</script>",
  "<kbd >",
  "<!--",
  "-->",
  "$",
  "\t",
];
const SMILEY_FRAGMENTS: readonly string[] = [
  ":)",
  ":-)",
  ";)",
  ":D",
  ":x",
  ":(",
  ":P",
  ":o",
  ":?",
  ":???:",
  ":!:",
  ":?:",
  ":arrow:",
  ":mrgreen:",
  ":wink:",
  "8)",
  "8-)",
  "8-O",
  "8O",
  ":-|",
  ":|",
  " ",
  " ",
  " ",
  "a",
  "b",
  "&nbsp;",
  "&amp;",
  "&lt;",
  " ",
  "\n",
  "\t",
  "x",
  ":",
  ")",
  "-",
  "'",
  '"',
  ";",
  "<b>",
  "é",
];
/** Strings put together from `fragments`, one to `max` pieces each, the same for the same seed. */
function fragmentCorpus(
  fragments: readonly string[],
  count: number,
  max: number,
  seed: number,
): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  while (out.length < count) {
    let s = "";
    for (let i = 1 + Math.floor(rnd() * max); i > 0; i--)
      s += fragments[Math.floor(rnd() * fragments.length)]!;
    out.push(s);
  }
  return out;
}

const chunked250 = (answers: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < answers.length; i += 250) out.push(digestOf(answers.slice(i, i + 250)));
  return out;
};

describe("review findings: a title-derived image alt has its typography done, as get_the_title() does", () => {
  // WordPress 6.8 under PHP 8.3: capital_P_dangit( trim( convert_chars( wptexturize( $title ) ) ) ).
  const vectors: [string, string][] = [
    ["Shaking Trump's Hand", "Shaking Trump&#8217;s Hand"],
    [
      "Ask Anabaptist Perspectives Anything - Episode 17",
      "Ask Anabaptist Perspectives Anything &#8211; Episode 17",
    ],
    ["Wait... what?", "Wait&#8230; what?"],
    [`"Quoted" and 'single'`, "&#8220;Quoted&#8221; and &#8216;single&#8217;"],
    ["The '90s and '99", "The &#8217;90s and &#8217;99"],
    [`Height 5'10" or 7' tall`, "Height 5&#8217;10&#8221; or 7&#8242; tall"],
    ["Q & A", "Q &#038; A"],
    ["3x4 and 10x20", "3&#215;4 and 10&#215;20"],
    ["Dash -- and --- and a-b", "Dash &#8212; and &#8212; and a-b"],
    ["Wordpress is not WordPress", "WordPress is not WordPress"],
    [`<b>Bold</b> "x" <code>"y"</code>`, `<b>Bold</b> &#8220;x&#8221; <code>"y"</code>`],
    ["  padded  ", "padded"],
    ["(tm) and ``tick'' ''", "(tm) and &#8220;tick&#8221; &#8221;"],
    ["Rock 'n' roll", "Rock &#8216;n&#8217; roll"],
    ["Tom & Jerry &amp; Co", "Tom &#038; Jerry &amp; Co"],
    [`Don't "stop" - believing`, "Don&#8217;t &#8220;stop&#8221; &#8211; believing"],
  ];
  for (const [title, want] of vectors) {
    test(JSON.stringify(title), () => expect(php.theTitle(title)).toBe(want));
  }

  test("a seeded corpus of awkward titles, against PHP's own answers", () => {
    const corpus = fragmentCorpus(TYPO_FRAGMENTS, 3000, 9, 20261003);
    expect(chunked250(corpus.map((t) => php.wptexturize(t)))).toEqual(
      "dcad5a18,dc8a6acf,09de815e,35113696,e63f08f2,0f02d533,f6716841,f0e0cbcb,fa63115a,ec722574,550b88b6,5641604d".split(
        ",",
      ),
    );
    expect(chunked250(corpus.map((t) => php.theTitle(t)))).toEqual(
      "370d6df4,a29d7acd,82bdf365,3271cf6d,0eeb3333,2bb0a80e,a81ec03c,f607a4df,d7c38c52,a6df435d,01f12751,19172151".split(
        ",",
      ),
    );
  });

  test("every post title of both sites, against PHP's own answers", () => {
    const digest = (site: Site): string =>
      digestOf(
        [...models[site].posts.values()]
          .sort((a, b) => a.id - b.id)
          .map((p) => php.theTitle(p.title)),
      );
    expect(digest("fineline")).toBe("1aa83184");
    expect(digest("ap")).toBe("153a1bea");
  });

  test("the alt of the image on a post whose attachment has none", () => {
    const att = wpAttachment({ id: 7, file: "a.jpg", width: 800, height: 600 });
    const seo = seoOfPost(
      { title: 'Shaking Trump&#8217;s "Hand" - Part 2' },
      { attachments: [att], postMeta: { _thumbnail_id: ["7"] } },
    );
    expect(seo.image?.alt).toBe("Shaking Trump’s “Hand” – Part 2");
    expect(seo.twitter.image?.alt).toBe("Shaking Trump’s “Hand” – Part 2");
  });

  test("a focus keyword is the alt as it was typed", () => {
    const att = wpAttachment({ id: 7, file: "a.jpg", width: 800, height: 600 });
    const seo = seoOfPost(
      { title: "Don't" },
      {
        attachments: [att],
        postMeta: { _thumbnail_id: ["7"], rank_math_focus_keyword: ["it's, other"] },
      },
    );
    expect(seo.image?.alt).toBe("it's");
  });
});

describe("review findings: convert_smilies, against PHP's own answers", () => {
  test("a seeded corpus of smilies and spaces", () => {
    const corpus = fragmentCorpus(SMILEY_FRAGMENTS, 3000, 7, 20261004);
    expect(chunked250(corpus.map((t) => php.convertSmilies(decodeEntities(t))))).toEqual(
      "c1bebbbe,9613dd08,ff8bea03,74259964,f57796ac,80b7923c,555b500e,2a2c9eef,fbc49aed,9c58dd3a,805bcdf8,3f103a0b".split(
        ",",
      ),
    );
  });
});

describe("review findings: toEntrySeo is the seo object of the entry data contract", () => {
  const validate = ajv.compile(BASE_PROPERTIES.seo!);
  test("every page of both live fixtures validates against the schema acf.ts publishes", () => {
    let withImage = 0;
    for (const site of ["fineline", "ap"] as const) {
      const model = models[site];
      for (const target of routesOf(model).values()) {
        const entry = toEntrySeo(seoFor(model, target));
        expect(validate(entry), JSON.stringify(validate.errors)).toBe(true);
        expect(
          Object.keys(entry).every((k) => ["title", "description", "robots", "image"].includes(k)),
        ).toBe(true);
        if (entry.image) {
          withImage++;
          expect(entry.image.src).toMatch(/^https?:\/\//);
          expect("url" in entry.image).toBe(false);
        }
      }
    }
    expect(withImage).toBeGreaterThan(50);
  });

  test("the raw Seo image, copied as it is, is what fails the schema", () => {
    const seo = seoOfPost(
      {},
      {
        attachments: [wpAttachment({ id: 7, file: "a.jpg", width: 800, height: 600 })],
        postMeta: { _thumbnail_id: ["7"] },
      },
    );
    expect(validate({ title: "", description: "", robots: "", image: seo.image })).toBe(false);
    expect(validate(toEntrySeo(seo))).toBe(true);
    expect(toEntrySeo(seo).image).toEqual({
      src: "https://x.test/wp-content/uploads/a.jpg",
      width: 800,
      height: 600,
      alt: "A Post",
    });
  });

  test("the project's own copy of the attachment wins, and keeps the alt the page printed when it has none", () => {
    const seo = seoOfPost(
      {},
      {
        attachments: [wpAttachment({ id: 7, file: "a.jpg", width: 800, height: 600 })],
        postMeta: { _thumbnail_id: ["7"] },
      },
    );
    const asked: number[] = [];
    const entry = toEntrySeo(seo, {
      attachment: (id) => {
        asked.push(id);
        return { src: "/media/a.jpg", width: 800, height: 600, alt: "" };
      },
    });
    expect(asked).toEqual([7]);
    expect(entry.image).toEqual({ src: "/media/a.jpg", width: 800, height: 600, alt: "A Post" });
    const own = toEntrySeo(seo, { attachment: () => ({ src: "/m/a.jpg", alt: "mine" }) });
    expect(own.image).toEqual({ src: "/m/a.jpg", alt: "mine" });
    // An attachment the hook cannot resolve falls back to the live address.
    expect(toEntrySeo(seo, { attachment: () => undefined }).image?.src).toBe(
      "https://x.test/wp-content/uploads/a.jpg",
    );
  });

  test("a page with no image has none", () => {
    const entry = toEntrySeo(seoOfPost({ title: "T" }));
    expect(entry).toEqual({ title: "T - X Site", description: "", robots: expect.any(String) });
    expect("image" in entry).toBe(false);
  });
});
// </review-fixes>
