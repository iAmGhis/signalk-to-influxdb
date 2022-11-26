const { InfluxDB, Point } = require("@influxdata/influxdb-client");
const { S2LatLng, S2CellId } = require("nodes2ts");

module.exports = function (app) {
  let unsubscribes = [];
  let writeApi;
  let latestLocation;
  // let boatName; For now using specific required field from Plugin

  const modifyPath = function (path, values, signalkTimestamp, options) {
    if (path == "navigation.position") {
      const pathLatitude = "navigation.position.latitude";
      const valueLatitude = values["latitude"];
      const timestamp = signalkTimestamp;

      const pathLongitude = "navigation.position.longitude";
      const valueLongitude = values["longitude"];

      const latitude = {
        path: pathLatitude,
        value: valueLatitude,
        timestamp: timestamp,
      };
      const longitude = {
        path: pathLongitude,
        value: valueLongitude,
        timestamp: timestamp,
      };

      // Replacing last known position
      latestLocation = { lat: valueLatitude, long: valueLongitude };

      return [latitude, longitude];
    }

    if (path == "navigation.attitude") {
      const pathRoll = "navigation.attitude.roll";
      const valueRoll = values["roll"];
      const timestamp = signalkTimestamp;

      const pathPitch = "navigation.attitude.pitch";
      const valuePitch = values["pitch"];

      const pathYaw = "navigation.attitude.yaw";
      const valueYaw = values["yaw"];

      const roll = { path: pathRoll, value: valueRoll, timestamp: timestamp };
      const pitch = {
        path: pathPitch,
        value: valuePitch,
        timestamp: timestamp,
      };
      const yaw = { path: pathYaw, value: valueYaw, timestamp: timestamp };

      return [roll, pitch, yaw];
    }

    if (path.includes("notifications")) {
      const timestamp = signalkTimestamp;
      let value;
      if (values === "normal") value = 0;
      else if (
        values === "alert" ||
        values === "critical" ||
        values === "alert" ||
        value === "emergency"
      )
        value = 1;

      return [
        {
          path: path,
          value: value,
          timestamp: timestamp,
        },
      ];
    }
  };

  const signalkPathCheck = function (path) {
    if (path == "navigation.position") {
      return true;
    }

    if (path == "navigation.attitude") {
      return true;
    }

    if (path.includes("notification")) {
      return true;
    }
  };

  const getInitMeasurement = function (options) {
    return options.pathArray.map((path) => app.getSelfPath(path.path));
  };

  const pathMatcher = function (path) {
    if (path === "") {
      return () => true;
    }
    const pattern = `${path.replace(".", "\\.?").replace("*", "")}.*`;
    const matcher = new RegExp("^" + pattern + "$");
    return (aPath) => matcher.test(aPath);
  };

  const getTagName = function (path, options) {
    const matchingOptions = options.pathArray.filter((opt) => {
      const matcher = pathMatcher(opt.path);
      return matcher(path);
    });

    // TODO: if matchingOptions is [], means wildcard forgotten, either we throw, either we manage that case
    if (matchingOptions.length === 0) return path.split(".")[0];

    app.debug("Matching options:", JSON.stringify(matchingOptions, null, 2));

    const reducer = (previousValue, currentValue) =>
    (currentValue =
      previousValue.path.length < currentValue.path.length
        ? currentValue
        : previousValue);

    const chosenOpt = matchingOptions.reduce(reducer);

    return {
      custom: chosenOpt.tag,
      measurmentType: chosenOpt.path.split(".")[0],
    };
  };

  const getLocationOption = function (path, options) {
    const matchingOptions = options.pathArray.filter((opt) => {
      const matcher = pathMatcher(opt.path);
      return matcher(path);
    });

    if (matchingOptions.length === 0) return false;

    app.debug("Matching options", JSON.stringify(matchingOptions, null, 2));

    const reducer = (previousValue, currentValue) =>
    (currentValue =
      previousValue.path.length < currentValue.path.length
        ? currentValue
        : previousValue);

    const chosenOpt = matchingOptions.reduce(reducer);

    app.debug("Option final match:", chosenOpt);

    return chosenOpt.addLoc ? chosenOpt.addLoc : false;
  };

  const isfloatField = function (n) {
    return Number(n) === n;
  };

  const capitalize = (str) => {
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  const influxFormat = function (path, values, signalkTimestamp, options) {
    const tags = getTagName(path, options);
    app.debug("Tag", tags);

    // Fieldname: we remove the first key, we split the rest with spaces
    const fieldname = path.split(".").slice(1).map(capitalize).join(" ");
    const point = new Point(options.influxMeasurement)
      .floatField(fieldname, values)
      .timestamp(Date.parse(signalkTimestamp))
      .tag("boatName", options.boat);

    for (const [key, value] of Object.entries(tags)) {
      if (value) point.tag(key, value);
    }

    if (getLocationOption(path, options) && latestLocation) {
      const cellId = new S2CellId.fromPoint(
        new S2LatLng.fromDegrees(
          latestLocation.lat,
          latestLocation.long
        ).toPoint()
      );

      // FIXME: harcoding level
      const token = cellId.toToken().slice(0, 8);


      point
        .floatField("lat", latestLocation.lat)
        .floatField("long", latestLocation.long)
        .tag("s2_cell_id", token);
    }
    app.debug("Point before writing:", point);

    return point;
  };

  // Main

  const process = function (u, options) {
    //if no u.values then return as there is no values to display
    if (!u?.values) {
      return;
    }

    const path = u.values[0].path;
    const values = u.values[0].value;
    const timestamp = u.timestamp;

    if (signalkPathCheck(path) == true) {
      // TODO: better to write everything in one point rather than multiple
      const pathArray = modifyPath(path, values, timestamp, options);
      pathArray.forEach((seperatePath) => {
        app.debug("Seperate path", seperatePath);
        if (isNaN(seperatePath["value"])) {
          return;
        } else {
          writeApi.writePoint(
            influxFormat(
              seperatePath.path,
              seperatePath.value,
              seperatePath.timestamp,
              options
            )
          );
        }
      });
    } else {
      if (isNaN(values) || !isfloatField(values) || !isFinite(values)) {
        app.debug(
          `Skipping path '${path}' because values is invalid, '${values}'`
        );
        return;
      } else {
        writeApi.writePoint(influxFormat(path, values, timestamp, options));
      }
    }
  };

  // Main
  const _localSubscription = function (options) {
    let subscribeArray = [];
    options.pathArray.forEach((path) => {
      const subscribe = {};
      subscribe.path = path.path;
      subscribe.policy = "instant";
      subscribe.minPeriod = path.interval;
      subscribe.something = "Test";
      subscribeArray.push(subscribe);
    });
    app.debug(subscribeArray);
    return (localSubscription = {
      context: "vessels.self",
      subscribe: subscribeArray,
    });
  };

  const _start = function (options) {
    app.debug(`${plugin.name} Started...`);
    const initMeasurements = getInitMeasurement(options);
    app.debug("Init measurements", JSON.stringify(initMeasurements, null, 2));

    initMeasurements.forEach((u) => process(u, options));

    //Set Variables from plugin options
    const url = options["influxHost"];
    const token = options["influxToken"];
    const org = options["influxOrg"];
    const bucket = options["influxBucket"];
    const writeOptions = options["writeOptions"];
    const defaultTags = {};

    if (options.defaultTags)
      options.defaultTags.forEach((tag) => {
        defaultTags[tag["tagName"]] = tag["tagValue"];
        app.debug(defaultTags);
      });

    //Create InfluxDB
    writeApi = new InfluxDB({
      url,
      token,
    }).getWriteApi(org, bucket, "ms", writeOptions);
    writeApi.useDefaultTags(defaultTags);

    app.subscriptionmanager.subscribe(
      _localSubscription(options),
      unsubscribes,
      (subscriptionError) => {
        app.error("Error:" + subscriptionError);
      },
      (delta) => {
        delta.updates.forEach((u) => {
          process(u, options);
        });
      }
    );
  };

  const _stop = async function (options) {
    app.debug(`${plugin.name} Stopped...`);
    unsubscribes.forEach((f) => f());
    unsubscribes = [];

    // Push the remaining data to influx before shutting down
    if (writeApi) {
      await writeApi.close();
      app.debug("All data written to InfluxDB");
    }
  };

  const plugin = {
    id: "signalk-to-influxdb-forked",
    name: "Signalk To Influxdb, with S2 Cell and tags overwrite",
    description:
      "Plugin that saves data to an influxdbv2 database - buffers data without internet connection",
    schema: {
      type: "object",
      required: [
        "influxHost",
        "influxToken",
        "influxOrg",
        "influxBucket",
        "uploadFrequency",
        "boat",
      ],
      properties: {
        influxHost: {
          type: "string",
          title: "Influxdb2.0 Host URL",
          description: "the url to your cloud hosted influxb2.0",
        },
        influxToken: {
          type: "string",
          title: "Influxdb2.0 Token",
          description: "the token for your cloud hosted influxb2.0 bucket",
        },
        influxOrg: {
          type: "string",
          title: "Influxdb2.0 Organisation",
          description: "your influxdb2.0 organistion",
        },
        influxBucket: {
          type: "string",
          title: "Influxdb2.0 Bucket",
          description: "which bucket you are storing the metrics in",
        },
        influxMeasurement: {
          type: "string",
          title: "Influxdb2.0 Measurement",
          description:
            "the measurement name to push the data to. Recommended to let the default value",
          default: "telemetry",
        },
        boat: {
          type: "string",
          title: "Boat ID / Name",
          description: "will be applied as tag on the points",
        },
        writeOptions: {
          type: "object",
          title: "Influx Write Options",
          required: [
            "batchSize",
            "flushInterval",
            "maxBufferLines",
            "maxRetries",
            "maxRetryDelay",
            "minRetryDelay",
            "retryJitter",
          ],
          properties: {
            batchSize: {
              type: "number",
              title: "Batch Size",
              description:
                "the maximum points/line to send in a single batch to InfluxDB server",
              default: 1000,
            },
            flushInterval: {
              type: "number",
              title: "Flush Interval",
              description:
                "maximum time in millis to keep points in an unflushed batch, 0 means don't periodically flush",
              default: 30000,
            },
            maxBufferLines: {
              type: "number",
              title: "Maximum Buffer Lines",
              description:
                "maximum size of the retry buffer - it contains items that could not be sent for the first time",
              default: 32000,
            },
            maxRetries: {
              type: "number",
              title: "Maximum Retries",
              description: "maximum delay between retries in milliseconds",
              default: 3,
            },
            maxRetryDelay: {
              type: "number",
              title: "Maximum Retry Delay",
              description: "maximum delay between retries in milliseconds",
              default: 5000,
            },
            minRetryDelay: {
              type: "number",
              title: "Minimum Retry Delay",
              description: "minimum delay between retries in milliseconds",
              default: 180000,
            },
            retryJitter: {
              type: "number",
              title: "Retry Jitter",
              description:
                "a random value of up to retryJitter is added when scheduling next retry",
              default: 200,
            },
          },
        },
        defaultTags: {
          type: "array",
          title: "Default Tags",
          default: [],
          items: {
            type: "object",
            required: ["tagName", "tagValue"],
            properties: {
              tagName: {
                type: "string",
                title: "Tag Name",
              },
              tagValue: {
                type: "string",
                title: "Tag Value",
              },
            },
          },
        },
        pathArray: {
          type: "array",
          title: "Paths",
          default: [],
          items: {
            type: "object",
            required: ["path", "interval"],
            properties: {
              path: {
                type: "string",
                title: "Signal K path to record",
              },
              interval: {
                type: "number",
                title: "Record Interval",
                default: 1000,
              },
              tag: {
                type: "string",
                title:
                  "Influx DB tag to apply. If not defined, tag will get the parent name of the path",
              },
              addLoc: {
                type: "boolean",
                title: "Add lat and long to this data point?",
                default: true,
              },
            },
          },
        },
      },
    },
    start: _start,
    stop: _stop,
  };

  return plugin;
};
