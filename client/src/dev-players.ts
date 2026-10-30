import type { Fields } from './wire';

// Live Fox snapshot fetched on 2026-10-30.
// Profiles: authenticated 20043/1001; games: TXWQFetchChessList.
// Latest 20 games per player, retaining only fields used by the history parser.
// Credentials and login tokens are never included in this offline fixture.
// The current board position and clocks remain independent preview scenarios.
export const PREVIEW_PLAYERS = [
  {
    uid: 531127799, name: '黑白双杀29', rank: 19,
    summary: {
      1: 0, 3: 531127799, 7: 19, 8: { 5: '黑白双杀29' },
      9: { 1: { 1: 6, 2: 0, 3: 9, 4: 0 }, 2: '-++-++-++-' },
      16: [{ 1: 0, 2: 427, 3: 407, 4: 0 }],
    } satisfies Fields,
    games: [
      {
        chessid: "1793308330030064800", gamestarttime: "1793308330",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 34253685, whiteenname: "products", whitedan: 20,
        winner: 2, reason: 2, point: -2, movenum: 166, additionalrule: 0,
      },
      {
        chessid: "1793302539030012254", gamestarttime: "1793302539",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 500272456, whiteenname: "泥彩1", whitedan: 19,
        winner: 1, reason: 3, point: -1, movenum: 185, additionalrule: 0,
      },
      {
        chessid: "1793281954030043290", gamestarttime: "1793281954",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 530768550, whiteenname: "V530768550", whitedan: 19,
        winner: 1, reason: 3, point: -1, movenum: 169, additionalrule: 0,
      },
      {
        chessid: "1793220212030054615", gamestarttime: "1793220212",
        blackuid: 533723285, blackenname: "hmm5678", blackdan: 19,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 19,
        winner: 1, reason: 3, point: -1, movenum: 225, additionalrule: 0,
      },
      {
        chessid: "1793211457030052163", gamestarttime: "1793211457",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 530914912, whiteenname: "水星记2024", whitedan: 19,
        winner: 1, reason: 3, point: -1, movenum: 219, additionalrule: 0,
      },
      {
        chessid: "1793208028030052921", gamestarttime: "1793208028",
        blackuid: 531217502, blackenname: "877025413", blackdan: 19,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 19,
        winner: 2, reason: 1, point: 1925, movenum: 278, additionalrule: 0,
      },
      {
        chessid: "1793201699030044774", gamestarttime: "1793201699",
        blackuid: 532364827, blackenname: "mingliang3", blackdan: 19,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 19,
        winner: 2, reason: 3, point: -1, movenum: 106, additionalrule: 0,
      },
      {
        chessid: "1793130405030044159", gamestarttime: "1793130405",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 532461414, whiteenname: "天亮了16", whitedan: 19,
        winner: 2, reason: 1, point: 25, movenum: 284, additionalrule: 0,
      },
      {
        chessid: "1793127238030063884", gamestarttime: "1793127238",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 532657988, whiteenname: "西竹子29", whitedan: 19,
        winner: 1, reason: 3, point: -1, movenum: 229, additionalrule: 0,
      },
      {
        chessid: "1793122648030051108", gamestarttime: "1793122648",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 500005105, whiteenname: "田一力945", whitedan: 19,
        winner: 1, reason: 3, point: -1, movenum: 230, additionalrule: 0,
      },
      {
        chessid: "1793040782030052763", gamestarttime: "1793040782",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 19,
        whiteuid: 533658792, whiteenname: "zzzzz08", whitedan: 20,
        winner: 2, reason: 3, point: -1, movenum: 228, additionalrule: 0,
      },
      {
        chessid: "1792962458030064525", gamestarttime: "1792962458",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 20,
        whiteuid: 532729439, whiteenname: "水中鱼59", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 200, additionalrule: 0,
      },
      {
        chessid: "1792940435030042003", gamestarttime: "1792940435",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 20,
        whiteuid: 27052889, whiteenname: "土村老歌", whitedan: 20,
        winner: 2, reason: 3, point: -1, movenum: 226, additionalrule: 0,
      },
      {
        chessid: "1792784864030051861", gamestarttime: "1792784864",
        blackuid: 531891613, blackenname: "tantan06", blackdan: 20,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 20,
        winner: 1, reason: 3, point: -1, movenum: 219, additionalrule: 0,
      },
      {
        chessid: "1792775842030032706", gamestarttime: "1792775842",
        blackuid: 533627713, blackenname: "杰克2天", blackdan: 20,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 20,
        winner: 1, reason: 3, point: -1, movenum: 329, additionalrule: 0,
      },
      {
        chessid: "1792768054030063843", gamestarttime: "1792768054",
        blackuid: 31940350, blackenname: "V319403501", blackdan: 20,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 20,
        winner: 2, reason: 3, point: -1, movenum: 208, additionalrule: 0,
      },
      {
        chessid: "1792703984030052674", gamestarttime: "1792703984",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 20,
        whiteuid: 531063024, whiteenname: "V531063024", whitedan: 20,
        winner: 1, reason: 3, point: -1, movenum: 193, additionalrule: 0,
      },
      {
        chessid: "1792690295030043134", gamestarttime: "1792690295",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 20,
        whiteuid: 533421213, whiteenname: "自然007", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 248, additionalrule: 0,
      },
      {
        chessid: "1792688962030034672", gamestarttime: "1792688962",
        blackuid: 532870237, blackenname: "纳兰晴川", blackdan: 20,
        whiteuid: 531127799, whiteenname: "黑白双杀29", whitedan: 20,
        winner: 2, reason: 3, point: -1, movenum: 102, additionalrule: 0,
      },
      {
        chessid: "1792684845030043409", gamestarttime: "1792684845",
        blackuid: 531127799, blackenname: "黑白双杀29", blackdan: 20,
        whiteuid: 531083719, whiteenname: "V531083719", whitedan: 20,
        winner: 2, reason: 3, point: -1, movenum: 150, additionalrule: 0,
      },
    ],
  },
  {
    uid: 533702962, name: '拉依苏圣泉', rank: 21,
    summary: {
      1: 0, 3: 533702962, 7: 21, 8: { 5: '拉依苏圣泉' },
      9: { 1: { 1: 10, 2: 0, 3: 2, 4: 0 }, 2: '-+---++-+-++---+--+-' },
      16: [{ 1: 0, 2: 157, 3: 43, 4: 1 }],
    } satisfies Fields,
    games: [
      {
        chessid: "1793333770030061788", gamestarttime: "1793333770",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 1280182, whiteenname: "风往北吹11", whitedan: 21,
        winner: 2, reason: 7, point: -3, movenum: 12, additionalrule: 0,
      },
      {
        chessid: "1793322416030034816", gamestarttime: "1793322416",
        blackuid: 1819276, blackenname: "办公室1230", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 7, point: -3, movenum: 174, additionalrule: 0,
      },
      {
        chessid: "1793322243030042830", gamestarttime: "1793322243",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 142798, whiteenname: "1419774851", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 32, additionalrule: 0,
      },
      {
        chessid: "1793304867030031618", gamestarttime: "1793304867",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 532770930, whiteenname: "吴江xjk", whitedan: 21,
        winner: 2, reason: 7, point: -3, movenum: 74, additionalrule: 0,
      },
      {
        chessid: "1793304101030053426", gamestarttime: "1793304101",
        blackuid: 500511251, blackenname: "V500511251", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 172, additionalrule: 0,
      },
      {
        chessid: "1793303490030052703", gamestarttime: "1793303490",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 500511251, whiteenname: "V500511251", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 166, additionalrule: 0,
      },
      {
        chessid: "1793302283030043339", gamestarttime: "1793302283",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 27128652, whiteenname: "飞象A", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 48, additionalrule: 0,
      },
      {
        chessid: "1793301550030064594", gamestarttime: "1793301550",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 27128652, whiteenname: "飞象A", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 184, additionalrule: 0,
      },
      {
        chessid: "1793300776030051689", gamestarttime: "1793300776",
        blackuid: 27128652, blackenname: "飞象A", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 176, additionalrule: 0,
      },
      {
        chessid: "1793285816030041458", gamestarttime: "1793285816",
        blackuid: 34067492, blackenname: "风中小草1", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 254, additionalrule: 0,
      },
      {
        chessid: "1793282731030051167", gamestarttime: "1793282731",
        blackuid: 532321154, blackenname: "大象树33", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 1, reason: 7, point: -3, movenum: 115, additionalrule: 0,
      },
      {
        chessid: "1793278810030043050", gamestarttime: "1793278810",
        blackuid: 337587, blackenname: "MNBBVCXX", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 123, additionalrule: 0,
      },
      {
        chessid: "1793274407030033047", gamestarttime: "1793274407",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 531276974, whiteenname: "善飞2148", whitedan: 21,
        winner: 2, reason: 7, point: -3, movenum: 76, additionalrule: 0,
      },
      {
        chessid: "1793273708030063824", gamestarttime: "1793273708",
        blackuid: 324052, blackenname: "阮汲", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 138, additionalrule: 0,
      },
      {
        chessid: "1793272588030033719", gamestarttime: "1793272588",
        blackuid: 532746264, blackenname: "狼图腾0622", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 268, additionalrule: 0,
      },
      {
        chessid: "1793271626030051103", gamestarttime: "1793271626",
        blackuid: 34221679, blackenname: "小迅冲", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 1, reason: 7, point: -3, movenum: 31, additionalrule: 0,
      },
      {
        chessid: "1793271089030034561", gamestarttime: "1793271089",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 500123246, whiteenname: "格力重1", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 66, additionalrule: 0,
      },
      {
        chessid: "1793268541030053799", gamestarttime: "1793268541",
        blackuid: 533702962, blackenname: "拉依苏圣泉", blackdan: 21,
        whiteuid: 3244209, whiteenname: "“魔界圣君", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 72, additionalrule: 0,
      },
      {
        chessid: "1793267132030062657", gamestarttime: "1793267132",
        blackuid: 531010786, blackenname: "南极雪花儿", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 2, reason: 3, point: -1, movenum: 232, additionalrule: 0,
      },
      {
        chessid: "1793266048030044441", gamestarttime: "1793266048",
        blackuid: 500511251, blackenname: "V500511251", blackdan: 21,
        whiteuid: 533702962, whiteenname: "拉依苏圣泉", whitedan: 21,
        winner: 1, reason: 3, point: -1, movenum: 155, additionalrule: 0,
      },
    ],
  },
];
