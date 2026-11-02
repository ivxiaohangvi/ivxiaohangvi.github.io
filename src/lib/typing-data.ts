import { pinyin } from 'pinyin-pro';

/**
 * 日记打字效果的服务端数据：
 * c = 单字默认全拼；w = 正文里可连打的 2–4 字词及上下文全拼；s = 同音候选池。
 * 只从已经过脱敏的正文生成；
 */
export interface TypingLexicon {
  c: Record<string, string>;
  w: Record<string, string[]>;
  s: Record<string, string>;
}

const PINYIN_OPTIONS = { toneType: 'none', type: 'array' } as const;
const HAN = /\p{Script=Han}/u;
const SENSITIVE = /[鱼魚🐟🐠🐡]/u;
const CANDIDATES_PER_SYLLABLE = 14;
const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 4;

const COMMON_CHARS =
  '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感' +
  '见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原满' +
  '班般搬板版半办伴帮邦榜膀棒包宝保饱报抱杯背北贝备奔本笨逼鼻比笔彼毕闭边编便变遍辨标表别宾冰兵病拨波玻博补布步才材财裁采彩菜参残惭惨仓苍藏操草册侧测层曾插查茶察差拆柴缠产尝常厂场敞畅唱抄超朝潮吵车彻尘沉陈衬称成呈承城乘程吃迟持池驰尺齿赤翅冲充虫抽仇愁筹丑臭初除厨础储触川穿传船喘串创窗床闯吹垂春纯唇词辞慈瓷次刺从匆聪丛凑粗促醋脆村存寸错搭达答打呆代带待袋丹单担胆旦但弹淡蛋当挡党荡刀导岛倒到德灯登等低滴敌底地第帝递点典店垫殿叼雕吊钓跌叠蝶丁盯钉顶订定丢东冬董懂冻洞都斗豆督毒独读堵赌杜渡端短段断堆队对吨顿多朵躲俄鹅额恶饿儿而耳二发罚法帆翻凡烦繁反返犯饭方防房仿访纺非肥废费芬纷粉份奋丰封疯峰锋蜂逢凤夫肤伏扶服浮符幅福抚府斧俯辅腐付妇负附复副富覆该改概盖干甘杆赶敢刚岗港高搞稿告哥歌搁割革格阁隔个各给根跟更耕弓公功攻供宫巩共贡勾沟狗构购够估姑孤古谷股骨鼓固故顾瓜刮挂乖拐怪关观官冠馆管惯灌贯光广归龟规鬼贵桂滚锅国果过哈孩海害含寒喊汉汗航毫好号浩喝合何河核荷盒贺黑痕很狠恨恒横衡轰红宏洪虹喉猴后厚候呼忽狐胡湖糊虎互户护花华划滑化画话怀坏欢环还缓幻换唤患荒慌皇黄灰挥恢辉回毁悔汇会绘惠昏婚浑混活火伙或货获祸击饥机肌鸡积基绩激及吉级极即急疾集几己挤计记纪技忌际季既继寄加夹佳甲价驾架假嫁尖坚间肩艰监减剪检简件建剑健渐践鉴键江将姜讲奖降交郊娇浇骄胶焦角脚搅叫轿较教阶皆接街节洁结姐解介戒届界借巾今斤金津仅尽紧锦谨进近劲禁京经茎惊晶睛井警净径竞竟敬静境镜究纠九久酒旧救就居局菊举巨拒具俱剧据距聚卷决绝觉军均君俊卡开刊堪砍看康抗科棵颗壳咳可渴克刻客课肯空孔恐控口扣哭枯苦库裤夸跨块快宽款筐况亏愧昆捆困扩括阔拉啦喇腊辣来赖兰拦栏蓝篮览懒烂郎狼朗浪劳牢老雷累泪类冷厘离梨犁礼李里理力历厉立丽利例隶连怜莲联脸练炼恋良凉梁量粮两亮谅辆列烈猎裂邻林临淋灵铃零龄领令另溜刘流留柳六龙咙笼聋隆楼搂漏陋芦炉鲁陆录鹿路驴旅铝律绿乱略伦轮论罗萝逻落妈麻马码骂吗埋买麦卖满慢忙猫毛矛茅贸帽么没眉梅媒煤每美妹门闷们孟米密蜜眠绵免勉面苗秒妙庙灭民敏名鸣命摸模膜摩磨末陌莫墨默谋某母亩木目牧墓幕拿哪纳乃奶耐男南难脑闹呢内嫩能尼泥你拟逆年念娘鸟您宁凝牛农弄努怒女暖挪欧偶爬帕怕拍排牌派攀盘判盼叛旁胖抛炮跑泡陪培赔佩配喷盆朋蓬捧碰批披皮疲匹屁偏片骗漂飘票拼贫频品平评凭瓶坡迫破剖扑铺朴普谱七期妻欺齐其奇骑棋旗乞企启起弃汽器恰千迁牵铅谦前钱浅遣欠枪强墙抢悄敲桥瞧巧切茄且窃亲侵琴勤青轻倾清情晴请庆穷秋求球区驱屈趋渠取去全权泉拳劝券缺却群然燃染嚷让饶扰绕热人仁忍认任扔仍日荣容肉如儒乳入软锐瑞润若弱撒洒塞赛三伞散扫色森杀沙纱傻晒山衫闪善伤商赏上尚梢烧少绍舌蛇舍设社射涉申伸身深神审甚升声省圣胜师诗施狮湿十什石识实拾食史使始驶士氏示世市式试事侍势视是适室逝释收手守首寿受兽授售瘦书叔殊舒疏输蔬熟属束述树数刷衰帅双霜水税睡顺说丝私思斯撕死四寺似松宋送搜苏俗诉素速塑酸虽随岁孙损缩所索锁' +
  '他她它塌塔踏台抬太态泰谈坦叹探堂糖躺烫掏逃桃陶讨套特疼藤梯踢提题体替天添田甜填挑条跳贴铁厅听停庭挺通同铜童统痛偷头投透突图涂土吐兔团推腿退吞托拖脱妥拓挖哇歪外弯完玩顽晚碗万亡王网往忘旺望危威微为围违唯维伟伪尾纬委卫未位味畏胃喂温文闻蚊吻稳问翁窝我卧握屋舞五午伍武侮勿物务悟误西吸希息悉惜稀溪席习洗喜系细戏虾瞎峡狭下夏仙先纤掀鲜闲弦咸显现限线宪陷献县相香箱详想向项巷象像橡消销小晓孝校笑效些歇协鞋写泄谢心辛欣新薪信兴星刑形醒幸姓性兄凶胸雄休修羞朽秀袖需徐许序叙蓄绪续宣悬旋选削穴学雪血寻巡询循训迅压呀押鸦鸭牙芽亚咽烟淹延严言岩沿炎研盐颜演厌宴验央秧扬羊阳杨仰养样腰邀摇药要耀爷也冶野业叶页夜液一衣医依仪宜姨移遗疑乙已以椅义亿忆艺议亦异役译易疫益意毅因阴音银引饮隐印应英迎盈影硬映拥永泳勇用优忧幽悠尤由犹油游友有又右幼诱于予余娱渔愉与宇羽雨语玉育郁狱浴预域欲遇裕元员园原圆援源远怨院愿约月岳悦阅越云匀允运晕韵杂灾栽载再在咱暂赞脏遭早造则责择泽贼怎增赠扎渣眨炸摘窄债寨占沾展战站张章涨掌帐招找召照罩遮折哲者这针侦珍真诊枕阵振震镇争征挣睁蒸整正证政症之支汁只枝知织脂执直侄值职植殖止旨纸指至志质治致智置中忠终钟肿种众重周州洲粥轴昼皱骤朱珠猪竹逐主煮嘱住助注驻祝著筑抓爪专砖转赚庄装壮状追准捉桌资姿子字自宗综总纵走奏租足族阻组钻嘴最罪尊遵昨左作坐座做' +
  '问但最手几报已给位次别真走女重物把被让名正想色回相间由四声电话打水话知理眼睛笑听写吃坐站睡醒慢快冷热高低多少远近新旧' +
  '风花雪月山海河湖江南北东西春夏秋冬早夜晚明暗光声音影像黑白红绿黄蓝紫银铜铁木石水火土云雨雾露霜冰' +
  '爱恨喜怒哀乐怕惊安静吵闹忙闲累困饿渴病痛健康美丑善恶真假梦醒记忆忘记等待寻找到达离开归来回去来往上下左右前后中间旁边' +
  '书纸笔字句读念思考感觉希望愿意需要应该可能或许因为所以如果但是虽然已经正在曾经将来现在过去未来谁';

const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

const wordSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;

const charCache = new Map<string, string>();
const wordCache = new Map<string, { key: string; syllables: string[] } | null>();

/** 单字默认读音的人工覆盖：pinyin-pro 给“了”单字标 liao，打字机按口语的 le 打 */
const SYLLABLE_OVERRIDES: Record<string, string> = { 了: 'le' };

function graphemes(input: string): string[] {
  if (!graphemeSegmenter) return Array.from(input);
  return Array.from(graphemeSegmenter.segment(input), ({ segment }) => segment);
}

function normalizeSyllable(value: string): string {
  return value.toLowerCase().replace(/ü/g, 'v').replace(/[^a-z]/g, '');
}

/** 去掉 Markdown / HTML 的壳，只留下人会读到的正文（含被涂黑处） */
function readableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/g, ' ');
}

function charSyllable(char: string): string {
  const cached = charCache.get(char);
  if (cached !== undefined) return cached;

  const result = pinyin(char, PINYIN_OPTIONS) as string[];
  const syllable = SYLLABLE_OVERRIDES[char] ?? normalizeSyllable(result[0] ?? '');
  charCache.set(char, syllable);
  return syllable;
}

function pronunciations(char: string): string[] {
  const syllable = charSyllable(char);
  return syllable ? [syllable] : [];
}

function wordEntry(segment: string): { key: string; syllables: string[] } | null {
  const cached = wordCache.get(segment);
  if (cached !== undefined) return cached;

  const chars = graphemes(segment).filter((char) => !/^\s+$/u.test(char));
  if (chars.length < MIN_WORD_LENGTH || chars.length > MAX_WORD_LENGTH) {
    wordCache.set(segment, null);
    return null;
  }
  if (!chars.every((char) => HAN.test(char)) || SENSITIVE.test(chars.join(''))) {
    wordCache.set(segment, null);
    return null;
  }

  const syllables = (pinyin(chars.join(''), PINYIN_OPTIONS) as string[]).map(normalizeSyllable);
  if (syllables.length !== chars.length || !syllables.every(Boolean)) {
    wordCache.set(segment, null);
    return null;
  }

  const entry = { key: chars.join(''), syllables };
  wordCache.set(segment, entry);
  return entry;
}

export function buildTypingLexicon(markdown: string): TypingLexicon | null {
  const text = readableText(markdown);
  const pageChars = new Set<string>();
  const words: Record<string, string[]> = {};

  for (const char of text) {
    if (HAN.test(char)) pageChars.add(char);
  }

  if (pageChars.size === 0) return null;

  const chars: Record<string, string> = {};
  for (const char of pageChars) {
    const syllable = charSyllable(char);
    if (syllable) chars[char] = syllable;
  }

  if (wordSegmenter) {
    for (const { segment } of wordSegmenter.segment(text)) {
      const entry = wordEntry(segment);
      if (entry) words[entry.key] = entry.syllables;
    }
  }

  const pool = new Set<string>();
  for (const char of COMMON_CHARS) {
    if (HAN.test(char) && !SENSITIVE.test(char)) pool.add(char);
  }
  for (const char of pageChars) {
    if (!SENSITIVE.test(char)) pool.add(char);
  }

  const buckets = new Map<string, string[]>();
  for (const char of pool) {
    for (const syllable of pronunciations(char)) {
      const bucket = buckets.get(syllable);
      if (!bucket) buckets.set(syllable, [char]);
      else if (!bucket.includes(char)) bucket.push(char);
    }
  }

  const syllables: Record<string, string> = {};
  for (const [syllable, list] of buckets) {
    syllables[syllable] = list.slice(0, CANDIDATES_PER_SYLLABLE).join('');
  }

  return { c: chars, w: words, s: syllables };
}
