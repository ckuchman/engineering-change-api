const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser')
const exphbs = require('express-handlebars');
const {Datastore} = require('@google-cloud/datastore');
const {google} = require('googleapis');
const jwt_decode = require('jwt-decode');

const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const REDIRECT_URL = process.env.REDIRECT_URL

// Taken from https://github.com/googleapis/google-api-nodejs-client
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URL
);

const app = express();
const datastore = new Datastore();

app.enable('trust proxy');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.engine('handlebars', exphbs({
  defaultLayout: 'main'
}));
app.set('view engine', 'handlebars');

/////////////////// General Datastore Access Functions ///////////////////

// Inserts the Entry into the Datastore and return entity or error results
function insertEntry(newEntry, objectName) {
  var result = {
    'status': null,
    'error': null,
    'key': null
  };

  // Add the entity to the datastore
  return new Promise(resolve => {
    datastore.insert(newEntry, (err, apiResponse) => {
      if (err) {
        result.status = 500;
        result.error = "Failed to insert " + objectName;
      } else {
        result.status = 201;
        if (apiResponse.mutationResults[0].key == null) {
          result.key = null;
        } else {
          result.key = apiResponse.mutationResults[0].key.path[0];
        }
      }
      resolve(result);
    });
  });
}


// Get the entry from the Datastore and return entity or error results
function getEntry(req, key, urlPath) {
  var result = {
    'status': null,
    'error': null,
    'entity': null
  };

  // Add the entity to the datastore
  return new Promise(resolve => {
    datastore.get(key, (err, entity) => {
      if (err || entity == undefined) {
        result.status = 404;
        result.error = "No entity with this id exists";
      } else {
        result.status = 200;
        entity.id = entity[datastore.KEY].id;
        entity.self = req.protocol + "://" + req.get("host") + urlPath + entity[datastore.KEY].id;
        result.entity = entity;
      }
      resolve(result);
    })
  });
}


// Get the entry list from the Datastore with a passed in query and returns the entries 
// data or any errors.
function getEntryList(req, query, urlPath, self=true) {
  var result = {
    'status': null,
    'error': null,
    'entities': null,
    'cursor': null
  };

  return new Promise(resolve => {
    datastore.runQuery(query, (err, entities, info) => {
      if (err) {
        console.log(err);
        result.status = 400;
        result.error = "Failed to get entry list";
      } else {
        // Add self and id to all entities
        entities.forEach(function(entity) {
          entity.id = entity[datastore.KEY].id;
          if (self) {
            entity.self = req.protocol + "://" + req.get("host") + urlPath + entity[datastore.KEY].id;
          }
        });

        // Add indicators for pagination
        if (info.moreResults != datastore.NO_MORE_RESULTS) {
          result.cursor = req.protocol + "://" + req.get("host") + urlPath + "?cursor=" + info.endCursor;
        }

        result.status = 200;
        result.entities = entities;
      }
      resolve(result);
    });
  });
}


// Modifies the entry in the Datastore and return error results
function editEntry(updatedEntity) {
  var result = {
    'status': null,
    'error': null
  };

  return new Promise(resolve => {
    datastore.update(updatedEntity, (err, apiResponse) => {
      if (err) {
        result.status = 404;
        result.error = "No entity with this id exists";
      } else {
        result.status = 200;
      }
      resolve(result);
    });
  });
}


// Delete the entry in the Datastore and return error results
function deleteEntry(entryKey) {
  var result = {
    'status': null,
    'error': null,
  };

  return new Promise(resolve => {
    datastore.delete(entryKey, (err, apiResponse) => {
      if (err ||apiResponse.indexUpdates == 0) {
        result.status = 404;
        result.error = "No entity with this id exists";
      } else {
        result.status = 204;
      }
      resolve(result);
    });
  });
}


/////////////////// Routing-Specific Functions ///////////////////


// Inserts the Entry and sends a response back with the entry information.
async function createEntry(req, res, newEntry, objectName, urlPath) {
  var response = {
    status: null,
    content: {}
  }

  var result = await insertEntry(newEntry, objectName);

  if (result.error == null) { 
    const entryData = await getEntry(req, result.key, urlPath);

    if (entryData.error == null) {
      response.status = result.status;
      response.content = entryData.entity;
    } else {
      response.status = entryData.status;
      response.content = {'Error': entryData.error};
    }
  } else {
    response.status = result.status;
    response.content = {'Error': result.error};
  }

  res.status(response.status).json(response.content);
}


/////////////////// General Functions ///////////////////

// Validate content request for JSON
function validJSONAccept(req, res) {
  if (req.get('Accept') != '*/*' && req.get('Accept') != 'application/json' && req.get('Accept') != 'text/html') {
    //Send response status and error message
    res.status(406).json({
      "Error": "The request asks for an unsupported media type"
    });
    return false
  }
  return true;
}

// Validates if the credentials exist
async function credentialsExist(req, res) {
  ticket = null;

  try {
    // Check the JWT value
    ticket = await oauth2Client.verifyIdToken({
      idToken: req.headers.authorization.substring(7),
      audience: CLIENT_ID
    });
  } catch (error) {
    //Send response status and error message
    res.status(403).json({
      "Error": "Credentials do not allow for access to this entity"
    });
  }

  return ticket;
}

////////////////////////////////// User and Auth Routing //////////////////////////


app.get("/", (req, res) => {
  res.render('welcome');
});


app.get("/info", (req, res) => {

  const url = oauth2Client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: 'online',
    scope: 'https://www.googleapis.com/auth/userinfo.profile'
  });
  
  res.redirect(url)
});


app.get("/oauth", async (req, res) => {

  // Get token ref:https://github.com/googleapis/google-api-nodejs-client
  const {tokens} = await oauth2Client.getToken(req.query.code);
  oauth2Client.credentials = tokens;

  // Decode the JWT to get sub value
  const decodedToken = jwt_decode(tokens.id_token);

  // Shorten the sub to useable length (for datastore to make a id)
  userID = decodedToken.sub.slice(0,16);

  // Check if user is already stored
  const key = datastore.key(['User', Number(userID)]);
  const oldEntity = await getEntry(req, key, "/users/");

  if (oldEntity.error != null) {
    // Prepares the new entity
    const userEntity = {
      key: key,
      data: {},
    };

    // Create entity
    await insertEntry(userEntity, "user");
  }

  res.render('user-info',
  {
    username: userID,
    jwt: oauth2Client.credentials.id_token
  });
});


// Get all Users
app.get('/users', async (req, res) => {

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }
  
  // Generate the query tied to the user
  query = datastore.createQuery("User").limit(5);

  if (req.query.cursor) {
    query.start(req.query.cursor);
  }

  const entryList = await getEntryList(req, query, "/users/", false);

  // Determine total count
  query = datastore.createQuery("User");

  const entryListCount = await getEntryList(req, query, "/users/", false);

  // Respond with entities list or error message
  if (entryList.error == null) {
    if (entryList.cursor != null) {
      res.status(entryList.status).json({
        'count': entryListCount.entities.length,
        'entities': entryList.entities,
        'next': entryList.cursor
      });
    } else {
      res.status(entryList.status).json({
        'count': entryListCount.entities.length,
        'entities': entryList.entities
      });
    }
  } else {
    res.status(entryList.status).json({'Error': entryList.error});
  }
});

/////////////////// Engineering Change Helper Functions ///////////////////

// Attribute valid check for EC. Determines that only valid attributes are used with
// valid data types.
function attributeCheckEC(req, res) {
  var validReq = true;

  // Check for duplicate inputs
  var typeCount = 0;
  var dateCount = 0;
  var historyCount = 0;
  var planCount = 0;
  
  for (prop in req.body) {
    switch(prop) {
      case 'type':
        if ((typeof req.body[prop] != 'string') || typeCount > 0) {
          validReq = false;
        }
        typeCount++;
        break;
      case 'date_created':
        if ((typeof req.body[prop] != 'string') || dateCount > 0) {
          validReq = false;
        }
        dateCount++;
        break;
      case 'history':
        if ((typeof req.body[prop] != 'string') || historyCount > 0) {
          validReq = false;
        }
        historyCount++;
        break;
      case 'plan':
        if ((typeof req.body[prop] != 'string') || planCount > 0) {
          validReq = false;
        }
        planCount++;
        break;
      default:
        validReq = false;
    }
  }

  if (validReq) {
    return true;
  } else {
    //Send response status and error message
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return false;
  }
}

// Required attribute check for EC.
function requiredAttributeCheckEC(req, res) {
  var containsHistory = false;
  var containsPlan = false;

  for (prop in req.body) {
    if (prop == 'history') {
      containsHistory = true;
    } else if (prop == 'plan') {
      containsPlan = true;
    }
  }
  
  if (containsHistory && containsPlan) {
    return true;
  } else {
    //Send response status and error message
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return false;
  }
}

// Default Attribute set for EC.
function defaultAttributeSetEC(req) {

  // Check for the optional attributes
  var containsType = false;
  var containsDate = false;

  for (prop in req.body) {
    if (prop == 'type') {
      containsType = true;
    } else if (prop == 'date_created') {
      containsDate = true;
    }
  }
  
  // Set the default values if missing
  if (!containsType) {
    req.body.type = "fast"
  }

  if (!containsDate) {
    // Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
    var [month, date, year] = new Date().toLocaleDateString("en-US").split("/")
    req.body.date_created = month + "/" + date + "/" + year

  }
}


// Check if the credentials allow access to record
async function validOwnerEC(req, res, ticket, key) {

  // Get engineering change to check owner
  const getResponse = await getEntry(req, key, "/engineering_changes/");
  if (getResponse.error != null) {
    res.status(getResponse.status).json({
      "Error": getResponse.error
    });
    return false;
  }

  // Return error if not the owner of the engineering change
  if (getResponse.entity.owner != ticket.getPayload().sub) {
    res.status(403).json({
      "Error": "Credentials do not allow for access to this entity"
    });
    return false;
  }

  return true;
}

/////////////////// Engineering Change Routing ///////////////////

// Create a Engineering Change
app.post('/engineering_changes', async (req, res) => {
  
  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckEC(req, res)) {
    return;
  }

  // Validate for all required
  if (!requiredAttributeCheckEC(req, res)) {
    return;
  }

  // Set default values if not provided
  defaultAttributeSetEC(req)

  // Prepares the new entity
  const ecEntity = {
    key: datastore.key('Engineering-Change'),
    data: {
      type: req.body.type,
      date_created: req.body.date_created,
      history: req.body.history,
      plan: req.body.plan,
      parts_changed: [],
      owner: ticket.getPayload().sub
    },
  };

  // Create entry and respond with values
  createEntry(req, res, ecEntity, "engineering change", "/engineering_changes/");
});


// Get a Engineering Change
app.get('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }
  
  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var owner = await validOwnerEC(req, res, ticket, key)
  if (!owner){
    return;
  }

  // Get entry from Datastore
  const entryData = await getEntry(req, key, "/engineering_changes/");

  // Respond with entity data or error message
  if (entryData.error != null) {
    res.status(entryData.status).json({'Error': entryData.error});
  } else {
    res.status(entryData.status).json(entryData.entity);
  }
});


// Get all Allowed Engineering Changes
app.get('/engineering_changes', async (req, res) => {

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }
  
  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  // Generate the query tied to the user
  query = datastore.createQuery("Engineering-Change").filter('owner', ticket.getPayload().sub).limit(5);

  if (req.query.cursor) {
    query.start(req.query.cursor);
  }

  const entryList = await getEntryList(req, query, "/engineering_changes/");

  // Determine total count
  query = datastore.createQuery("Engineering-Change").filter('owner', ticket.getPayload().sub);

  const entryListCount = await getEntryList(req, query, "/engineering_changes/");


  // Respond with entities list or error message
  if (entryList.error == null) {
    if (entryList.cursor != null) {
      res.status(entryList.status).json({
        'count': entryListCount.entities.length,
        'entities': entryList.entities,
        'next': entryList.cursor
      });
    } else {
      res.status(entryList.status).json({
        'count': entryListCount.entities.length,
        'entities': entryList.entities
      });
    }
  } else {
    res.status(entryList.status).json({'Error': entryList.error});
  }
});


// Update a Engineering Change
app.put('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var owner = await validOwnerEC(req, res, ticket, key)
  if (!owner){
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckEC(req, res)) {
    return;
  }

  // Validate for all required
  if (!requiredAttributeCheckEC(req, res)) {
    return;
  }

  // Set default values if not provided
  defaultAttributeSetEC(req)

  // Prepare the updated entity
  const ecEntity = {
    key: key,
    data: {
      type: req.body.type,
      date_created: req.body.date_created,
      history: req.body.history,
      plan: req.body.plan,
      parts_changed: [],  //TODO Should it clear relationship?
      owner: ticket.getPayload().sub
    },
  };

  const editResponse = await editEntry(ecEntity);

  // Respond with entities list or error message
  if (editResponse.error == null) {
    // Populate return entity
    entity = ecEntity.data
    entity.id = req.params.ec_id;
    entity.self = req.protocol + "://" + req.get("host") + "/engineering_changes/" + req.params.ec_id;
    res.status(303).set("Location", entity.self).json(entity);
  } else {
    res.status(editResponse.status).json({'Error': editResponse.error});
  }
});


// Edit a Engineering Change
app.patch('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var owner = await validOwnerEC(req, res, ticket, key)
  if (!owner){
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckEC(req, res)) {
    return;
  }

  // Validate that atleast one attribute is being provided
  var propCounter = 0
  for (prop in req.body) {
    propCounter++;
  }

  if (propCounter == 0) {
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return;
  }

  // Get old from Datastore
  const oldData = await getEntry(req, key, "/engineering_changes/");

  //Determine old or new value
  var type, dateCreated, history, plan;

  if (req.body.type != undefined) {
    type = req.body.type;
  } else {
    type = oldData.entity.type;
  }

  if (req.body.date_created != undefined) {
    dateCreated = req.body.date_created;
  } else {
    dateCreated = oldData.entity.date_created;
  }

  if (req.body.history != undefined) {
    history = req.body.history;
  } else {
    history = oldData.entity.history;
  }

  if (req.body.plan != undefined) {
    plan = req.body.plan;
  } else {
    plan = oldData.entity.plan;
  }

  // Prepare the updated entity
  const ecEntity = {
    key: key,
    data: {
      type: type,
      date_created: dateCreated,
      history: history,
      plan: plan,
      parts_changed: oldData.entity.parts_changed,
      owner: oldData.entity.owner,
    },
  };

  const editResponse = await editEntry(ecEntity);

  // Respond with entities list or error message
  if (editResponse.error == null) {
    // Populate return entity
    entity = ecEntity.data
    entity.id = req.params.ec_id;
    entity.self = req.protocol + "://" + req.get("host") + "/engineering_changes/" + req.params.ec_id;
    res.status(editResponse.status).json(entity);
  } else {
    res.status(editResponse.status).json({'Error': editResponse.error});
  }
});


// Delete a Engineering Change
app.delete('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);
  
  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var owner = await credentialsExist(req, res, ticket, key)
  if (!owner){
    return;
  }

  const deleteResponse = await deleteEntry(key);

  // Respond with entities list or error message
  if (deleteResponse.error == null) {
    res.status(deleteResponse.status).send();
  } else {
    res.status(deleteResponse.status).json({'Error': deleteResponse.error});
  }
});


/////////////////// Part Change Helper Functions ///////////////////

// Attribute valid check for PR. Determines that only valid attributes are used with
// valid data types.
function attributeCheckPR(req, res) {
  var validReq = true;

  // Check for duplicate inputs
  var fileCount = 0;
  var dateCount = 0;
  var revisionCount = 0;
  var changeCount = 0;
  
  for (prop in req.body) {
    switch(prop) {
      case 'file_name':
        if ((typeof req.body[prop] != 'string') || fileCount > 0) {
          validReq = false;
        }
        fileCount++;
        break;
      case 'date_created':
        if ((typeof req.body[prop] != 'string') || dateCount > 0) {
          validReq = false;
        }
        dateCount++;
        break;
      case 'revision':
        if ((typeof req.body[prop] != 'string') || revisionCount > 0) {
          validReq = false;
        }
        revisionCount++;
        break;
      case 'change':
        if ((typeof req.body[prop] != 'string') || changeCount > 0) {
          validReq = false;
        }
        changeCount++;
        break;
      default:
        validReq = false;
    }
  }

  if (validReq) {
    return true;
  } else {
    //Send response status and error message
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return false;
  }
}

// Required attribute check for PR.
function requiredAttributeCheckPR(req, res) {
  var containsFileName = false;
  var containsRevision = false;
  var containsChange = false;

  for (prop in req.body) {
    if (prop == 'file_name') {
      containsFileName = true;
    } else if (prop == 'revision') {
      containsRevision = true;
    } else if (prop == 'change') {
      containsChange = true;
    }
  }
  
  if (containsFileName && containsRevision && containsChange) {
    return true;
  } else {
    //Send response status and error message
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return false;
  }
}

// Default Attribute set for PR.
function defaultAttributeSetPR(req) {

  // Check for the optional attributes
  var containsDate = false;

  for (prop in req.body) {
    if (prop == 'date_changed') {
      containsDate = true;
    }
  }
  
  if (!containsDate) {
    // Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
    var [month, date, year] = new Date().toLocaleDateString("en-US").split("/")
    req.body.date_created = month + "/" + date + "/" + year

  }
}

/////////////////// Part Change Routing ///////////////////

// Create a Part Change
app.post('/part_changes', async (req, res) => {
  
  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckPR(req, res)) {
    return;
  }

  // Validate for all required
  if (!requiredAttributeCheckPR(req, res)) {
    return;
  }

  // Set default values if not provided
  defaultAttributeSetPR(req)

  // Prepares the new entity
  const partChangeEntity = {
    key: datastore.key('Part-Change'),
    data: {
      file_name: req.body.file_name,
      date_created: req.body.date_created,
      revision: req.body.revision,
      change: req.body.change,
      engineering_change_id: null
    },
  };

  // Create entry and respond with values
  createEntry(req, res, partChangeEntity, "part change", "/part_changes/");
});


// Get a Part Change
app.get('/part_changes/:pr_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Part-Change', Number(req.params.pr_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Get entry from Datastore
  const entryData = await getEntry(req, key, "/part_changes/");

  // Respond with entity data or error message
  if (entryData.error != null) {
    res.status(entryData.status).json({'Error': entryData.error});
  } else {
    res.status(entryData.status).json(entryData.entity);
  }
});


// Get all Allowed Part Changes
app.get('/part_changes', async (req, res) => {

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Generate the query for all part changes
  query = datastore.createQuery("Part-Change").limit(5);

  if (req.query.cursor) {
    query.start(req.query.cursor);
  }

  const entryList = await getEntryList(req, query, "/part_changes/");

  // Determine total count
  query = datastore.createQuery("Part-Change");

  const entryListCount = await getEntryList(req, query, "/part_changes/");


  // Respond with entities list or error message
  if (entryList.error == null) {
    if (entryList.cursor != null) {
      res.status(entryList.status).json({
        'count': entryListCount.entities.length,
        'entities': entryList.entities,
        'next': entryList.cursor
      });
    } else {
      res.status(entryList.status).json({
        'count': entryListCount.entities.length,
        'entities': entryList.entities
      });
    }
  } else {
    res.status(entryList.status).json({'Error': entryList.error});
  }
});


// Update a Part Change
app.put('/part_changes/:pr_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Part-Change', Number(req.params.pr_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckPR(req, res)) {
    return;
  }

  // Validate for all required
  if (!requiredAttributeCheckPR(req, res)) {
    return;
  }

  // Set default values if not provided
  defaultAttributeSetPR(req)

  // Prepare the updated entity
  const partChangeEntity = {
    key: key,
    data: {
      file_name: req.body.file_name,
      date_created: req.body.date_created,
      revision: req.body.revision,
      change: req.body.change,
      engineering_change_id: null, //TODO should this clear?
      owner: ticket.getPayload().sub
    },
  };

  const editResponse = await editEntry(partChangeEntity);

  // Respond with entities list or error message
  if (editResponse.error == null) {
    // Populate return entity
    entity = partChangeEntity.data
    entity.id = req.params.pr_id;
    entity.self = req.protocol + "://" + req.get("host") + "/part_changes/" + req.params.pr_id;
    res.status(303).set("Location", entity.self).json(entity);
  } else {
    res.status(editResponse.status).json({'Error': editResponse.error});
  }
});


// Edit a Part Change
app.patch('/part_changes/:pr_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Part-Change', Number(req.params.pr_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckPR(req, res)) {
    return;
  }

  // Validate that atleast one attribute is being provided
  var propCounter = 0
  for (prop in req.body) {
    propCounter++;
  }

  if (propCounter == 0) {
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return;
  }

  // Get old from Datastore
  const oldData = await getEntry(req, key, "/part_changes/");

  // Return error if not an existing id
  if (oldData.error != null) {
    res.status(404).json({
      "Error": "No entity with this id exists"
    });
    return;
  }

  //Determine old or new value
  var fileName, dateCreated, revision, change;

  if (req.body.file_name != undefined) {
    fileName = req.body.file_name;
  } else {
    fileName = oldData.entity.file_name;
  }

  if (req.body.date_created != undefined) {
    dateCreated = req.body.date_created;
  } else {
    dateCreated = oldData.entity.date_created;
  }

  if (req.body.revision != undefined) {
    revision = req.body.revision;
  } else {
    revision = oldData.entity.revision;
  }

  if (req.body.change != undefined) {
    change = req.body.change;
  } else {
    change = oldData.entity.change;
  }

  // Prepare the updated entity
  const partChangeEntity = {
    key: key,
    data: {
      file_name: fileName,
      date_created: dateCreated,
      revision: revision,
      change: change,
      engineering_change_id: oldData.entity.engineering_change_id
    },
  };

  const editResponse = await editEntry(partChangeEntity);

  // Respond with entities list or error message
  if (editResponse.error == null) {
    // Populate return entity
    entity = partChangeEntity.data
    entity.id = req.params.pr_id;
    entity.self = req.protocol + "://" + req.get("host") + "/part_changes/" + req.params.pr_id;
    res.status(editResponse.status).json(entity);
  } else {
    res.status(editResponse.status).json({'Error': editResponse.error});
  }
});


// Delete a Part Change
app.delete('/part_changes/:pr_id', async (req, res) => {

  // Get entity key
  const key = datastore.key(['Part-Change', Number(req.params.pr_id)]);

  const deleteResponse = await deleteEntry(key);

  // Respond with entities list or error message
  if (deleteResponse.error == null) {
    res.status(deleteResponse.status).send();
  } else {
    res.status(deleteResponse.status).json({'Error': deleteResponse.error});
  }
});


// Listen to the App Engine-specified port, or 8080 otherwise
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}...`);
});