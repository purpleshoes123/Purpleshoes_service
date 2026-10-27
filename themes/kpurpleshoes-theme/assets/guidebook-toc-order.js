/**
 * Purple Shoes guidebook — category order aligned with the mobile app (GuidebookHomeScreen).
 * Sorts API category trees by title using the same depth-1 order and section lists as the app.
 */
(function (global) {
  'use strict';

  var GUIDEBOOK_DEPTH1_ORDER = [
    'How to Use This Guide',
    'Before You Begin',
    'Basic Information',
    'Preparing for Your Trip',
    'Explore by Theme',
    'Seoul',
    'Beyond Seoul',
    'Appendix',
  ];

  var BASIC_INFO_ITEMS = [
    'Quick Overview',
    "Korea's Four Seasons & Weather",
    'Korea Festival Calendar',
    'What Makes Korea Special',
  ];

  var PREPARING_ITEMS = [
    'Travel Prep Summary',
    'Entry Checklist',
    'Packing Guide',
    'Transportation Guide',
    'Must-Have Apps',
  ];

  var APPENDIX_ITEMS = [
    'K-Culture & Tips\nKnow Before You Go',
    'Korea: A Brief History',
    'Korean Etiquette & Culture',
    'Essential Travel Korean',
  ];

  function titlesFromMixed(arr) {
    return arr.map(function (x) {
      return typeof x === 'string' ? x : x.title;
    });
  }

  var THEME_ITEMS = titlesFromMixed([
    { title: '[Theme 1 — Food]', isHeader: true },
    { title: 'Must-Try Korean Dishes' },
    { title: 'Korean BBQ' },
    { title: 'Seafood' },
    { title: 'Soup & Stew' },
    { title: 'Noodles' },
    { title: 'Snacks & Street Food' },
    { title: 'Korean Drinks' },
    { title: 'Convenience Store Food' },
    { title: 'Desserts' },
    { title: 'Fine Dining' },
    { title: 'Vegetarian & Vegan Options' },
    { title: 'Korean Favorites' },
    { title: '[Theme 2 — Traditional Markets]', isHeader: true },
    { title: 'Gwangjang Sijang Market' },
    { title: 'Mangwon Sijang Market' },
    { title: 'Tongin Sijang Market' },
    { title: 'Noryangjin Susan Sijang Fish Market' },
    { title: '[Theme 3 — Photo Spots]', isHeader: true },
    { title: 'Sunset Views' },
    { title: 'Cityscapes & Night Views' },
    { title: 'Tradition Meets Modernity' },
    { title: 'Korean Aesthetics' },
    { title: '[Theme 4 — Activities]', isHeader: true },
    { title: 'K - Performances' },
    { title: 'K-Culture Experiences' },
    { title: 'K-Local Culture Activities' },
    { title: 'Mega Complexes Resorts' },
    { title: 'Amusement Parks' },
    { title: 'Water Parks & Hot Springs' },
    { title: 'Media Art' },
    { title: 'K-Pop Experiences' },
    { title: '[Theme 5 — Shopping]', isHeader: true },
    { title: 'Drugstores' },
    { title: 'Hypermarkets' },
    { title: 'Department Stores' },
    { title: 'Outlets' },
    { title: 'Daiso' },
    { title: 'ARTBOX' },
    { title: '[Theme 6 — Tradition]', isHeader: true },
    { title: 'Palaces' },
    { title: 'Temples' },
    { title: 'Museums' },
    { title: '[Theme 7 — Wellness]', isHeader: true },
    { title: 'Hiking & Scenic Trail' },
    { title: 'Temple Stay' },
    { title: 'Spa' },
    { title: 'Medical Treatment' },
  ]);

  var SEOUL_ITEMS = titlesFromMixed([
    { title: 'Seoul District Overview' },
    { title: 'Seoul Hangang Park' },
    { title: 'Seoul [Jongno-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
    { title: 'Seoul [Jung-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
    { title: 'Seoul [Mapo-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
    { title: 'Seoul [Gangnam-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
    { title: 'Seoul [Yongsan-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
    { title: 'Seoul [Songpa-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
    { title: 'Seoul [Seongdong-gu]', isHeader: true },
    { title: 'Quick Overview' },
    { title: 'Neighborhood Highlights' },
    { title: 'Landmarks ＆ Scenic Spots' },
    { title: 'Food & Coffee' },
    { title: 'Unique Experiences' },
  ]);

  var BEYOND_TOP_ORDER = ['Incheon', 'Busan', 'Jeju', 'Gyeongju', 'Gangwon-do'];

  var BEYOND_CITY_COMMON_ORDER = [
    'Quick Overview',
    'Transportation',
    'Neighborhood Highlights',
    'Landmarks ＆ Scenic Spots',
    'Food & Coffee',
    'Shopping',
    'Unique Experiences',
  ];

  var BEYOND_JEJU_ORDER = [
    'Quick Overview',
    'Transportation',
    'Landmarks ＆ Scenic Spots',
    'Beaches',
    'Food & Coffee',
    'Unique Experiences',
  ];

  var JEJU_HIDDEN_CATEGORIES = ['Neighborhood Highlights & Markets', 'Neighborhood Highlights'];

  var BEYOND_SUB_SECTIONS = ['Gangneung', 'Sokcho', 'Pyeongchang', 'Chuncheon', 'Hongje & Inje'];

  var BEYOND_SUB_TOWN_ORDER = ['Quick Overview', 'Neighborhood Highlights', 'Must-Try Local Foods'];

  var SEOUL_DISTRICT_INNER_ORDER = [
    'Quick Overview',
    'Neighborhood Highlights',
    'Landmarks ＆ Scenic Spots',
    'Food & Coffee',
    'Unique Experiences',
  ];

  var GANGWON_CHILD_ORDER = ['Quick Overview', 'Transportation'].concat(BEYOND_SUB_SECTIONS);

  function buildFirstIndexMap(orderList) {
    var map = {};
    if (!orderList) return map;
    orderList.forEach(function (title, i) {
      if (map[title] === undefined) map[title] = i;
    });
    return map;
  }

  function reorderInPlace(arr, orderList) {
    if (!arr || !arr.length || !orderList || !orderList.length) return;
    var map = buildFirstIndexMap(orderList);
    arr.sort(function (a, b) {
      var ia = map[a.title] !== undefined ? map[a.title] : 10000;
      var ib = map[b.title] !== undefined ? map[b.title] : 10000;
      if (ia !== ib) return ia - ib;
      return String(a.title).localeCompare(String(b.title));
    });
  }

  function getChildOrderForParent(title) {
    if (!title) return null;
    var t = String(title);
    switch (t) {
      case 'Basic Information':
        return BASIC_INFO_ITEMS;
      case 'Preparing for Your Trip':
        return PREPARING_ITEMS;
      case 'Appendix':
        return APPENDIX_ITEMS;
      case 'Explore by Theme':
        return THEME_ITEMS;
      case 'Seoul':
        return SEOUL_ITEMS;
      case 'Beyond Seoul':
        return BEYOND_TOP_ORDER;
      case 'Gangwon-do':
        return GANGWON_CHILD_ORDER;
      case 'Incheon':
      case 'Busan':
      case 'Gyeongju':
        return BEYOND_CITY_COMMON_ORDER;
      case 'Jeju':
        return BEYOND_JEJU_ORDER;
      default:
        break;
    }
    if (/^Seoul \[/i.test(t)) return SEOUL_DISTRICT_INNER_ORDER;
    if (BEYOND_SUB_SECTIONS.indexOf(t) !== -1) return BEYOND_SUB_TOWN_ORDER;
    return null;
  }

  /**
   * Mutates category tree in place (same node objects — itemsById stays valid).
   * @param {Array} nodes
   * @param {string|undefined} parentTitle - undefined for root (depth-1)
   */
  function applyGuidebookTocOrder(nodes, parentTitle) {
    if (!nodes || !nodes.length) return;

    if (parentTitle === 'Jeju') {
      for (var i = nodes.length - 1; i >= 0; i--) {
        if (JEJU_HIDDEN_CATEGORIES.indexOf(nodes[i].title) !== -1) {
          nodes.splice(i, 1);
        }
      }
    }

    if (parentTitle === undefined) {
      reorderInPlace(nodes, GUIDEBOOK_DEPTH1_ORDER);
    } else {
      var order = getChildOrderForParent(parentTitle);
      if (order) reorderInPlace(nodes, order);
    }

    nodes.forEach(function (node) {
      if (node.children && node.children.length) {
        applyGuidebookTocOrder(node.children, node.title);
      }
    });
  }

  global.applyGuidebookTocOrder = function (nodes) {
    applyGuidebookTocOrder(nodes, undefined);
  };
})(typeof window !== 'undefined' ? window : this);
