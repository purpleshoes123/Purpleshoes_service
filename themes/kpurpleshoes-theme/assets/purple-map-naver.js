(function (global) {
  'use strict';
  var pending = null;
  function createAdapter(n) {
    function unwrap(map) { return map && map.nativeMap ? map.nativeMap : map; }
    function coordinate(point) {
      return { getLat: function () { return point.lat(); }, getLng: function () { return point.lng(); } };
    }
    function MapAdapter(element, options) {
      this.nativeMap = new n.Map(element, {
        center: options.center, zoom: 19 - options.level, minZoom: 6, maxZoom: 20,
        scaleControl: true, mapDataControl: true, logoControl: true
      });
    }
    MapAdapter.prototype.getCenter = function () { return coordinate(this.nativeMap.getCenter()); };
    MapAdapter.prototype.getBounds = function () {
      var bounds = this.nativeMap.getBounds();
      return {
        getSouthWest: function () { return coordinate(bounds.getSW()); },
        getNorthEast: function () { return coordinate(bounds.getNE()); }
      };
    };
    MapAdapter.prototype.setCenter = function (point) { this.nativeMap.setCenter(point); };
    MapAdapter.prototype.panTo = function (point) { this.nativeMap.panTo(point); };
    MapAdapter.prototype.setLevel = function (level) { this.nativeMap.setZoom(19 - level); };
    MapAdapter.prototype.getLevel = function () { return 19 - this.nativeMap.getZoom(); };
    MapAdapter.prototype.relayout = function () { this.nativeMap.refresh(true); };
    function MarkerImage(src, size, options) {
      return { url: src, size: size, scaledSize: size, anchor: options.offset };
    }
    function Marker(options) {
      var marker = new n.Marker({
        map: unwrap(options.map) || null, position: options.position, title: options.title,
        icon: options.image, zIndex: options.zIndex || 0, clickable: options.clickable !== false
      });
      marker.setImage = function (image) { marker.setIcon(image); };
      var setMap = marker.setMap.bind(marker);
      marker.setMap = function (map) { setMap(unwrap(map)); };
      return marker;
    }
    function InfoWindow(options) {
      var info = new n.InfoWindow({
        content: '', borderWidth: 0, backgroundColor: 'transparent',
        disableAnchor: true, disableAutoPan: !!options.disableAutoPan,
        pixelOffset: new n.Point(0, -8), zIndex: options.zIndex || 1000
      });
      var open = info.open.bind(info);
      info.open = function (map, marker) { open(unwrap(map), marker); };
      return info;
    }
    function MarkerClusterer(options) {
      this.map = unwrap(options.map);
      this.options = options;
      this.markers = [];
      this.groups = [];
      this.listener = null;
    }
    MarkerClusterer.prototype.clearGroups = function () {
      this.groups.forEach(function (group) {
        n.Event.clearInstanceListeners(group);
        group.setMap(null);
      });
      this.groups = [];
    };
    MarkerClusterer.prototype.clear = function () {
      if (this.listener) n.Event.removeListener(this.listener);
      this.listener = null;
      this.clearGroups();
      this.markers.forEach(function (marker) { marker.setMap(null); });
      this.markers = [];
    };
    MarkerClusterer.prototype.addMarkers = function (markers) {
      this.markers = this.markers.concat(markers);
      if (!this.listener) this.listener = n.Event.addListener(this.map, 'idle', this.redraw.bind(this));
      this.redraw();
    };
    MarkerClusterer.prototype.redraw = function () {
      this.clearGroups();
      var self = this;
      var zoom = this.map.getZoom();
      var radius = zoom <= 11 ? 160 : zoom <= 13 ? 128 : zoom <= 14 ? 112 :
        zoom <= 15 ? 96 : zoom <= 16 ? 80 : zoom <= 17 ? 64 :
        zoom <= 18 ? 48 : zoom < 20 ? 36 : 0;
      var buckets = Object.create(null);
      var clusters = [];
      this.markers.forEach(function (marker) {
        marker.setMap(null);
        if (!radius || marker.getZIndex() >= 999) {
          marker.setMap(self.map);
          return;
        }
        var p = marker.getPosition();
        var sin = Math.sin(p.lat() * Math.PI / 180);
        var scale = 256 * Math.pow(2, zoom);
        var x = (p.lng() + 180) / 360 * scale;
        var y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
        var cellX = Math.floor(x / radius), cellY = Math.floor(y / radius);
        var nearest = null, distance = radius * radius;
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            (buckets[(cellX + dx) + ':' + (cellY + dy)] || []).forEach(function (candidate) {
              var d = Math.pow(x - candidate.x, 2) + Math.pow(y - candidate.y, 2);
              if (d <= distance) { nearest = candidate; distance = d; }
            });
          }
        }
        if (!nearest) {
          nearest = { x: x, y: y, items: [] };
          var key = cellX + ':' + cellY;
          (buckets[key] || (buckets[key] = [])).push(nearest);
          clusters.push(nearest);
        }
        nearest.items.push(marker);
      });
      clusters.forEach(function (cluster) {
        var items = cluster.items;
        if (items.length < (self.options.minClusterSize || 2)) {
          items.forEach(function (marker) { marker.setMap(self.map); });
          return;
        }
        var lat = 0, lng = 0;
        items.forEach(function (marker) { lat += marker.getPosition().lat(); lng += marker.getPosition().lng(); });
        var position = new n.LatLng(lat / items.length, lng / items.length);
        var diameter = items.length >= 50 ? 48 : items.length >= 10 ? 42 : 36;
        var group = new n.Marker({
          map: self.map, position: position, zIndex: 20, title: items.length + ' places',
          icon: {
            content: '<div style="box-sizing:border-box;width:' + diameter + 'px;height:' + diameter + 'px;border:3px solid white;border-radius:50%;background:#5B2BD8;color:white;text-align:center;line-height:' + (diameter - 6) + 'px;font-size:13px;font-weight:800;box-shadow:0 4px 12px #4c1d9559">' + items.length + '</div>',
            size: new n.Size(diameter, diameter), anchor: new n.Point(diameter / 2, diameter / 2)
          }
        });
        n.Event.addListener(group, 'click', function () {
          self.map.setCenter(position);
          self.map.setZoom(Math.min(20, Math.floor(zoom) + 1));
        });
        self.groups.push(group);
      });
    };
    return { maps: {
      Map: MapAdapter, Marker: Marker, MarkerImage: MarkerImage, InfoWindow: InfoWindow,
      MarkerClusterer: MarkerClusterer, LatLng: n.LatLng, Size: n.Size, Point: n.Point,
      event: { addListener: function (target, event, callback) { return n.Event.addListener(unwrap(target), event, callback); } }
    } };
  }
  function load(clientId) {
    if (!clientId || !clientId.trim()) return Promise.reject(new Error('MISSING_NAVER_MAPS_CLIENT_ID'));
    if (pending) return pending;
    pending = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var finished = false;
      var previousAuthFailure = global.navermap_authFailure;
      var timer = setTimeout(function () { finish(new Error('NAVER_MAPS_LOAD_TIMEOUT')); }, 15000);
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        global.navermap_authFailure = previousAuthFailure;
        if (error) { script.remove(); reject(error); }
        else resolve(createAdapter(global.naver.maps));
      }
      global.navermap_authFailure = function () { finish(new Error('NAVER_MAPS_AUTH_FAILED')); };
      script.async = true;
      script.src = 'https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=' + encodeURIComponent(clientId.trim()) + '&language=en';
      script.onload = function () {
        if (!global.naver || !global.naver.maps || !global.naver.maps.Map) finish(new Error('NAVER_MAPS_UNAVAILABLE'));
        else finish();
      };
      script.onerror = function () { finish(new Error('NAVER_MAPS_SCRIPT_FAILED')); };
      document.head.appendChild(script);
    }).catch(function (error) { pending = null; throw error; });
    return pending;
  }
  global.KPSNaverMaps = { load: load, createAdapter: createAdapter };
})(window);
